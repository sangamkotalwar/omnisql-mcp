import net from 'net';
import fs from 'fs';
import { Readable } from 'stream';
import { Client, ConnectConfig } from 'ssh2';
import {
  DatabaseConnection,
  SSHHop,
  SSHHopSummary,
  SSHTunnelConfig,
  SSHTunnelInfo,
} from './types.js';

const DEFAULT_CONNECT_TIMEOUT_MS = 10000;

interface OpenTunnel {
  server: net.Server;
  localPort: number;
  clients: Client[];
}

/**
 * Manages SSH tunnels for database connections that route through an SSH jump host
 * (as configured via the DB client's "ssh_tunnel" network handler, including chained
 * jump servers / gateway hosts). Each tunnel opens a local TCP listener that forwards
 * traffic through the SSH hop chain to the target database host:port, mirroring how
 * the DBeaver-compatible client itself tunnels connections.
 *
 * Tunnels are cached per connection ID and reused across queries; call closeAllTunnels()
 * during shutdown to tear them down cleanly.
 */
export class SSHTunnelManager {
  private tunnels: Map<string, OpenTunnel> = new Map();
  private pending: Map<string, Promise<OpenTunnel>> = new Map();
  private debug: boolean;

  constructor(debug = false) {
    this.debug = debug;
  }

  private log(message: string): void {
    if (this.debug) {
      console.error(`[SSHTunnel] ${message}`);
    }
  }

  /**
   * Resolve the local {host, port} to connect to in order to reach this connection's
   * target database. Returns null when the connection has no enabled SSH tunnel /
   * jump host profile, in which case callers should connect directly.
   */
  async getTunnelEndpoint(
    connection: DatabaseConnection
  ): Promise<{ host: string; port: number } | null> {
    const config = connection.sshTunnel;
    if (!config || !config.enabled) {
      return null;
    }

    const targetHost = connection.host || connection.properties?.host;
    const targetPort =
      connection.port ||
      (connection.properties?.port ? parseInt(connection.properties.port, 10) : undefined);

    if (!targetHost || !targetPort) {
      throw new Error(
        `Connection "${connection.name}" has an SSH tunnel configured but is missing a target host/port`
      );
    }

    const key = connection.id;

    const existing = this.tunnels.get(key);
    if (existing) {
      return { host: '127.0.0.1', port: existing.localPort };
    }

    const inFlight = this.pending.get(key);
    if (inFlight) {
      const tunnel = await inFlight;
      return { host: '127.0.0.1', port: tunnel.localPort };
    }

    const creation = this.openTunnel(key, connection.name, config, targetHost, targetPort);
    this.pending.set(key, creation);

    try {
      const tunnel = await creation;
      this.tunnels.set(key, tunnel);
      return { host: '127.0.0.1', port: tunnel.localPort };
    } finally {
      this.pending.delete(key);
    }
  }

  /**
   * Build the ordered chain of SSH hops to connect through: configured jump servers
   * (gateway hosts) first, ending with the handler's own host, which is the hop that
   * can reach the target database.
   */
  private buildHopChain(config: SSHTunnelConfig): SSHHop[] {
    const finalHop: SSHHop = {
      host: config.host,
      port: config.port,
      username: config.username,
      authType: config.authType,
      password: config.password,
      privateKeyPath: config.privateKeyPath,
      passphrase: config.passphrase,
    };

    return [...config.jumpServers, finalHop];
  }

  private buildConnectConfig(hop: SSHHop, timeoutMs: number): ConnectConfig {
    const authType = (hop.authType || 'PASSWORD').toUpperCase();
    const connectConfig: ConnectConfig = {
      host: hop.host,
      port: hop.port || 22,
      username: hop.username,
      readyTimeout: timeoutMs,
    };

    if (authType === 'PUBLIC_KEY' && hop.privateKeyPath) {
      connectConfig.privateKey = fs.readFileSync(hop.privateKeyPath);
      if (hop.passphrase) {
        connectConfig.passphrase = hop.passphrase;
      }
    } else if (authType === 'AGENT') {
      connectConfig.agent = process.env.SSH_AUTH_SOCK;
    } else {
      connectConfig.password = hop.password;
    }

    return connectConfig;
  }

  /**
   * Connect through a chain of SSH hops, piping each connection through the previous
   * hop's tunnel (SSH-over-SSH via ssh2's `sock` option), and resolve with every Client
   * opened along the way, in order, so they can be torn down together.
   */
  private connectChain(hops: SSHHop[], timeoutMs: number): Promise<Client[]> {
    return new Promise((resolve, reject) => {
      const clients: Client[] = [];
      let settled = false;

      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        this.closeClients(clients);
        reject(error);
      };

      const connectHop = (index: number, sock?: Readable) => {
        const hop = hops[index];
        const client = new Client();
        clients.push(client);

        client.on('ready', () => {
          this.log(`Connected SSH hop ${index + 1}/${hops.length}: ${hop.host}:${hop.port}`);

          if (index === hops.length - 1) {
            settled = true;
            resolve(clients);
            return;
          }

          const nextHop = hops[index + 1];
          client.forwardOut('127.0.0.1', 0, nextHop.host, nextHop.port || 22, (err, stream) => {
            if (err) {
              fail(new Error(`Failed to forward through jump host ${hop.host}: ${err.message}`));
              return;
            }
            connectHop(index + 1, stream as unknown as Readable);
          });
        });

        client.on('error', (err) => {
          fail(new Error(`SSH connection to ${hop.host}:${hop.port} failed: ${err.message}`));
        });

        try {
          const connectConfig = this.buildConnectConfig(hop, timeoutMs);
          if (sock) {
            connectConfig.sock = sock;
          }
          client.connect(connectConfig);
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)));
        }
      };

      connectHop(0);
    });
  }

  private closeClients(clients: Client[]): void {
    for (const client of clients) {
      try {
        client.end();
      } catch {
        // ignore
      }
    }
  }

  private async openTunnel(
    connectionId: string,
    connectionName: string,
    config: SSHTunnelConfig,
    targetHost: string,
    targetPort: number
  ): Promise<OpenTunnel> {
    const timeoutMs = config.connectTimeout || DEFAULT_CONNECT_TIMEOUT_MS;
    const hops = this.buildHopChain(config);

    this.log(
      `Opening SSH tunnel for "${connectionName}" via ${hops.map((h) => h.host).join(' -> ')} -> ${targetHost}:${targetPort}`
    );

    const clients = await this.connectChain(hops, timeoutMs);
    const lastClient = clients[clients.length - 1];

    const server = net.createServer((socket) => {
      lastClient.forwardOut(
        socket.remoteAddress || '127.0.0.1',
        socket.remotePort || 0,
        targetHost,
        targetPort,
        (err, stream) => {
          if (err) {
            this.log(`Tunnel forward error for "${connectionName}": ${err.message}`);
            socket.destroy();
            return;
          }
          socket.pipe(stream).pipe(socket);
          stream.on('error', () => socket.destroy());
          socket.on('error', () => stream.destroy());
        }
      );
    });

    const localPort = await new Promise<number>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (address && typeof address === 'object') {
          resolve(address.port);
        } else {
          reject(new Error('Failed to determine local SSH tunnel port'));
        }
      });
    });

    this.log(`SSH tunnel for "${connectionName}" listening on 127.0.0.1:${localPort}`);

    // If the underlying SSH connection drops, evict the cached tunnel so the next
    // query attempt reopens it instead of connecting to a dead local listener.
    for (const client of clients) {
      client.on('error', () => this.tunnels.delete(connectionId));
      client.on('close', () => this.tunnels.delete(connectionId));
    }

    return { server, localPort, clients };
  }

  async closeTunnel(connectionId: string): Promise<void> {
    const tunnel = this.tunnels.get(connectionId);
    if (!tunnel) return;

    this.tunnels.delete(connectionId);
    this.closeClients(tunnel.clients);
    try {
      tunnel.server.close();
    } catch {
      // ignore
    }
  }

  async closeAllTunnels(): Promise<void> {
    const ids = Array.from(this.tunnels.keys());
    await Promise.all(ids.map((id) => this.closeTunnel(id)));
  }

  hasTunnel(connectionId: string): boolean {
    return this.tunnels.has(connectionId);
  }

  /**
   * Build a redacted, display-safe summary of a connection's SSH tunnel / jump host
   * profile without opening any network connection. Used by the get_ssh_tunnel_info tool.
   */
  getTunnelInfo(connection: DatabaseConnection): SSHTunnelInfo {
    const config = connection.sshTunnel;

    if (!config) {
      return {
        connectionId: connection.id,
        connectionName: connection.name,
        enabled: false,
        jumpServers: [],
        message: 'No SSH tunnel / jump host profile is configured for this connection.',
      };
    }

    const summarize = (hop: SSHHop): SSHHopSummary => ({
      host: hop.host,
      port: hop.port,
      username: hop.username,
      authType: hop.authType,
      hasPassword: !!hop.password,
      hasPrivateKey: !!hop.privateKeyPath,
      privateKeyPath: hop.privateKeyPath,
    });

    return {
      connectionId: connection.id,
      connectionName: connection.name,
      enabled: config.enabled,
      finalHop: summarize(config),
      jumpServers: config.jumpServers.map(summarize),
      targetHost: connection.host || connection.properties?.host,
      targetPort:
        connection.port ||
        (connection.properties?.port ? parseInt(connection.properties.port, 10) : undefined),
      implementation: config.implementation,
      message: config.enabled
        ? undefined
        : 'SSH tunnel is configured for this connection but currently disabled.',
    };
  }
}

export const sshTunnelManager = new SSHTunnelManager();
