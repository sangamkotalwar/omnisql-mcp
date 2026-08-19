import fs from 'fs';
import path from 'path';
import os from 'os';
import { parseString } from 'xml2js';
import { promisify } from 'util';
import crypto from 'crypto';
import { DatabaseConnection, SSHHop, SSHTunnelConfig, WorkspaceConfig } from './types.js';

const parseXML = promisify(parseString);

// The local DB client (DBeaver-compatible) uses these hardcoded values for password encryption
const WORKSPACE_AES_KEY = Buffer.from('babb4a9f774ab853c96c2d653dfe544a', 'hex');
const WORKSPACE_AES_IV = Buffer.alloc(16, 0);

// The network handler id the DB client (DBeaver-compatible) uses for SSH tunnel / jump host config
const SSH_TUNNEL_HANDLER_IDS = ['ssh_tunnel', 'ssh'];

export class WorkspaceConfigParser {
  private config: WorkspaceConfig;
  private isNewFormat: boolean = false;

  constructor(config: WorkspaceConfig = {}) {
    const workspacePath = config.workspacePath ?? this.getDefaultWorkspacePath();
    const debug = config.debug ?? false;
    this.config = {
      ...config,
      workspacePath,
      debug,
    };

    // Detect which workspace config format is in use (new JSON vs legacy XML)
    this.isNewFormat = this.detectNewFormat();
  }

  private detectNewFormat(): boolean {
    const newFormatPath = path.join(
      this.config.workspacePath!,
      'General',
      '.dbeaver',
      'data-sources.json'
    );
    const oldFormatPath = path.join(
      this.config.workspacePath!,
      '.metadata',
      '.plugins',
      'org.jkiss.dbeaver.core',
      'connections.xml'
    );

    // If new format exists, use it
    if (fs.existsSync(newFormatPath)) {
      return true;
    }

    // If old format exists, use it
    if (fs.existsSync(oldFormatPath)) {
      return false;
    }

    // If neither exists, check for new format directory structure
    const newFormatDir = path.join(this.config.workspacePath!, 'General', '.dbeaver');
    const oldFormatDir = path.join(this.config.workspacePath!, '.metadata');

    // Prefer new format if its directory structure exists
    if (fs.existsSync(newFormatDir)) {
      return true;
    }

    // Default to old format if metadata directory exists
    if (fs.existsSync(oldFormatDir)) {
      return false;
    }

    // Default to new format for newer DB client installations
    return true;
  }

  private getDefaultWorkspacePath(): string {
    const platform = os.platform();
    const homeDir = os.homedir();

    switch (platform) {
      case 'win32':
        return path.join(homeDir, 'AppData', 'Roaming', 'DBeaverData', 'workspace6');
      case 'darwin':
        return path.join(homeDir, 'Library', 'DBeaverData', 'workspace6');
      default: // Linux and others
        return path.join(homeDir, '.local', 'share', 'DBeaverData', 'workspace6');
    }
  }

  private getConnectionsFilePath(): string {
    if (this.isNewFormat) {
      return path.join(this.config.workspacePath!, 'General', '.dbeaver', 'data-sources.json');
    } else {
      return path.join(
        this.config.workspacePath!,
        '.metadata',
        '.plugins',
        'org.jkiss.dbeaver.core',
        'connections.xml'
      );
    }
  }

  private getCredentialsFilePath(): string {
    if (this.isNewFormat) {
      return path.join(
        this.config.workspacePath!,
        'General',
        '.dbeaver',
        'credentials-config.json'
      );
    } else {
      return path.join(
        this.config.workspacePath!,
        '.metadata',
        '.plugins',
        'org.jkiss.dbeaver.core',
        'credentials-config.json'
      );
    }
  }

  async parseConnections(): Promise<DatabaseConnection[]> {
    const connectionsFile = this.getConnectionsFilePath();

    if (!fs.existsSync(connectionsFile)) {
      // Try the alternative format if the detected format file doesn't exist
      const alternativeFormat = !this.isNewFormat;
      const alternativeFile = alternativeFormat
        ? path.join(this.config.workspacePath!, 'General', '.dbeaver', 'data-sources.json')
        : path.join(
            this.config.workspacePath!,
            '.metadata',
            '.plugins',
            'org.jkiss.dbeaver.core',
            'connections.xml'
          );

      if (fs.existsSync(alternativeFile)) {
        // Switch to the alternative format and retry
        this.isNewFormat = alternativeFormat;
        return this.parseConnections();
      }

      // Neither format exists - return empty array instead of throwing error
      if (this.config.debug) {
        console.warn(
          `No workspace connections found. Checked:\n- ${connectionsFile}\n- ${alternativeFile}`
        );
      }
      return [];
    }

    try {
      let connections: DatabaseConnection[] = [];

      if (this.isNewFormat) {
        connections = await this.parseNewFormatConnections(connectionsFile);
      } else {
        connections = await this.parseOldFormatConnections(connectionsFile);
      }

      // Load and merge credentials
      await this.loadCredentials(connections);

      return connections;
    } catch (error) {
      throw new Error(`Failed to parse workspace connections: ${error}`);
    }
  }

  private async parseNewFormatConnections(filePath: string): Promise<DatabaseConnection[]> {
    const jsonContent = fs.readFileSync(filePath, 'utf-8');
    const data = JSON.parse(jsonContent);

    const connections: DatabaseConnection[] = [];

    if (!data.connections) {
      return connections;
    }

    for (const [connectionId, connData] of Object.entries(data.connections)) {
      const conn = connData as any;

      const connection: DatabaseConnection = {
        id: connectionId,
        name: conn.name || connectionId,
        driver: conn.driver || conn.provider || '',
        url: '',
        folder: conn.folder || '',
        description: conn.description || '',
        readonly: conn.readonly === true,
      };

      // Extract properties from the new format
      if (conn.configuration) {
        const config = conn.configuration;
        connection.properties = {
          url: config.url || '',
          user: config.user || '',
          host: config.host || '',
          port: config.port ? String(config.port) : '',
          database: config.database || '',
          server: config.server || '',
          ...config,
        };

        connection.url = config.url || '';
        connection.user = config.user || '';
        connection.host = config.host || config.server || '';
        connection.port = config.port ? parseInt(String(config.port)) : undefined;
        connection.database = config.database || '';
      }

      // Network handlers (SSH tunnel / jump host profile) live alongside `configuration`,
      // but some workspace versions nest them under `configuration.handlers` instead.
      // A connection can also reference a shared, reusable "Network Profile" by name
      // (configuration['config-profile']) instead of embedding its own handler config -
      // in that case the actual host/port/auth live in the top-level `network-profiles`
      // block and the connection's own `handlers.ssh_tunnel` is just an enabled flag.
      const profileName = conn.configuration?.['config-profile'];
      const profileHandlers = profileName
        ? data['network-profiles']?.[profileName]?.handlers
        : undefined;
      const handlers = profileHandlers || conn.handlers || conn.configuration?.handlers;
      const sshTunnel = this.extractSSHTunnelConfig(handlers);
      if (sshTunnel) {
        sshTunnel.profileName = profileHandlers ? profileName : undefined;
        connection.sshTunnel = sshTunnel;
      }

      connections.push(connection);
    }

    return connections;
  }

  private async parseOldFormatConnections(filePath: string): Promise<DatabaseConnection[]> {
    const xmlContent = fs.readFileSync(filePath, 'utf-8');
    const result = await parseXML(xmlContent);

    return this.extractConnections(result);
  }

  private extractConnections(xmlData: any): DatabaseConnection[] {
    const connections: DatabaseConnection[] = [];

    if (!xmlData.connections || !xmlData.connections.connection) {
      return connections;
    }

    const connectionArray = Array.isArray(xmlData.connections.connection)
      ? xmlData.connections.connection
      : [xmlData.connections.connection];

    for (const conn of connectionArray) {
      const connection: DatabaseConnection = {
        id: conn.$.id || '',
        name: conn.$.name || '',
        driver: conn.$.driver || '',
        url: '',
        folder: conn.$.folder || '',
        description: conn.$.description || '',
        readonly: conn.$.readonly === 'true',
      };

      // Extract properties
      if (conn.property) {
        const properties: Record<string, string> = {};
        const propArray = Array.isArray(conn.property) ? conn.property : [conn.property];

        for (const prop of propArray) {
          if (prop.$ && prop.$.name && prop.$.value) {
            properties[prop.$.name] = prop.$.value;
          }
        }

        connection.properties = properties;
        connection.url = properties.url || '';
        connection.user = properties.user || '';
        connection.host = properties.host || '';
        connection.port = properties.port ? parseInt(properties.port) : undefined;
        connection.database = properties.database || '';
      }

      // Network handlers (SSH tunnel / jump host profile), legacy XML format.
      // Each <handler> element mirrors <connection> in shape: attributes on $, plus <property> children.
      if (conn.handler) {
        const handlers: Record<string, any> = {};
        const handlerArray = Array.isArray(conn.handler) ? conn.handler : [conn.handler];

        for (const handler of handlerArray) {
          const handlerId = handler.$?.id || handler.$?.type;
          if (!handlerId) continue;

          const handlerProps: Record<string, string> = {};
          if (handler.property) {
            const propArray = Array.isArray(handler.property)
              ? handler.property
              : [handler.property];
            for (const prop of propArray) {
              if (prop.$ && prop.$.name && prop.$.value !== undefined) {
                handlerProps[prop.$.name] = prop.$.value;
              }
            }
          }

          handlers[handlerId] = {
            type: handler.$?.type,
            enabled: handler.$?.enabled === 'true' || handler.$?.enabled === true,
            properties: handlerProps,
          };
        }

        const sshTunnel = this.extractSSHTunnelConfig(handlers);
        if (sshTunnel) {
          connection.sshTunnel = sshTunnel;
        }
      }

      connections.push(connection);
    }

    return connections;
  }

  /**
   * Extract an SSH tunnel / jump host profile from a connection's `handlers` block
   * (the DB client's network handler configuration). Handles both the DBeaver-compatible
   * "ssh_tunnel" handler's own host/port/auth and any chained `jumpServerN.*` gateway hosts.
   */
  private extractSSHTunnelConfig(handlers: unknown): SSHTunnelConfig | undefined {
    if (!handlers || typeof handlers !== 'object') {
      return undefined;
    }

    const handlersObj = handlers as Record<string, any>;
    let handler: any;

    for (const candidate of SSH_TUNNEL_HANDLER_IDS) {
      if (handlersObj[candidate]) {
        handler = handlersObj[candidate];
        break;
      }
    }

    if (!handler) {
      return undefined;
    }

    const props: Record<string, unknown> = handler.properties || {};
    const str = (v: unknown): string | undefined =>
      v === undefined || v === null || v === '' ? undefined : String(v);
    const num = (v: unknown, fallback: number): number => {
      const n = parseInt(String(v ?? ''), 10);
      return Number.isFinite(n) ? n : fallback;
    };
    const bool = (v: unknown): boolean => v === true || v === 'true';

    const host = str(props.host);
    if (!host) {
      // Handler block exists but has no target host configured - nothing usable to report.
      return undefined;
    }

    // Group jump server properties by index. Observed workspace formats vary:
    // "jumpServerN.xxx" (no separator before the index) and "jumpServer.N.xxx" (dot-separated),
    // alongside a "jumpServer.count" property that records how many are configured. Support both.
    const jumpIndexes = new Set<number>();
    const jumpPrefixPatterns = [/^jumpServer(\d+)\./, /^jumpServer\.(\d+)\./];
    for (const key of Object.keys(props)) {
      for (const pattern of jumpPrefixPatterns) {
        const match = pattern.exec(key);
        if (match) {
          jumpIndexes.add(parseInt(match[1], 10));
          break;
        }
      }
    }

    const jumpProp = (idx: number, suffix: string): unknown =>
      props[`jumpServer${idx}.${suffix}`] ?? props[`jumpServer.${idx}.${suffix}`];

    const jumpServers: SSHHop[] = Array.from(jumpIndexes)
      .sort((a, b) => a - b)
      .filter((idx) => bool(jumpProp(idx, 'enabled') ?? true))
      .map((idx) => ({
        host: str(jumpProp(idx, 'host')) || '',
        port: num(jumpProp(idx, 'port'), 22),
        username: str(jumpProp(idx, 'name') ?? jumpProp(idx, 'user')),
        authType: str(jumpProp(idx, 'authType')) || 'PASSWORD',
        password: str(jumpProp(idx, 'password')),
        privateKeyPath: str(jumpProp(idx, 'keyPath')),
        passphrase: str(jumpProp(idx, 'keyPassword') ?? jumpProp(idx, 'passphrase')),
      }))
      .filter((hop) => hop.host);

    return {
      enabled: bool(handler.enabled),
      host,
      port: num(props.port, 22),
      username: str(props.user ?? props.username),
      authType: str(props.authType) || 'PASSWORD',
      password: str(props.password),
      privateKeyPath: str(props.keyPath),
      passphrase: str(props.keyPassword ?? props.passphrase),
      jumpServers,
      implementation: str(props.implementation),
      bypassHostVerification: bool(props.bypassHostVerification),
      aliveInterval: props.aliveInterval !== undefined ? num(props.aliveInterval, 0) : undefined,
      connectTimeout:
        props['tunnel-connect-timeout'] !== undefined
          ? num(props['tunnel-connect-timeout'], 0)
          : undefined,
    };
  }

  async getConnection(connectionId: string): Promise<DatabaseConnection | null> {
    try {
      const connections = await this.parseConnections();
      return (
        connections.find((conn) => conn.id === connectionId || conn.name === connectionId) || null
      );
    } catch (error) {
      if (this.config.debug) {
        console.error(`Failed to get connection ${connectionId}: ${error}`);
      }
      return null;
    }
  }

  async validateConnection(connectionId: string): Promise<boolean> {
    const connection = await this.getConnection(connectionId);

    if (!connection) {
      return false;
    }

    // Basic validation - check if essential properties exist
    return !!(connection.url || (connection.host && connection.driver));
  }

  getWorkspacePath(): string {
    return this.config.workspacePath!;
  }

  async getDriverInfo(driverId: string): Promise<any> {
    if (this.isNewFormat) {
      // New format doesn't have a separate drivers.xml file
      // Driver info is embedded in the data-sources.json
      return null;
    }

    const driversFile = path.join(
      this.config.workspacePath!,
      '.metadata',
      '.plugins',
      'org.jkiss.dbeaver.core',
      'drivers.xml'
    );

    if (!fs.existsSync(driversFile)) {
      return null;
    }

    try {
      const xmlContent = fs.readFileSync(driversFile, 'utf-8');
      const result: any = await parseXML(xmlContent);

      if (!result.drivers || !result.drivers.driver) {
        return null;
      }

      const driverArray = Array.isArray(result.drivers.driver)
        ? result.drivers.driver
        : [result.drivers.driver];

      return driverArray.find((driver: any) => driver.$.id === driverId) || null;
    } catch (error) {
      if (this.config.debug) {
        console.error(`Failed to parse drivers file: ${error}`);
      }
      return null;
    }
  }

  async getConnectionFolders(): Promise<string[]> {
    const connections = await this.parseConnections();
    const folders = new Set<string>();

    connections.forEach((conn) => {
      if (conn.folder) {
        folders.add(conn.folder);
      }
    });

    return Array.from(folders).sort();
  }

  isWorkspaceValid(): boolean {
    const workspacePath = this.config.workspacePath!;

    if (this.isNewFormat) {
      const newFormatPath = path.join(workspacePath, 'General', '.dbeaver');
      return fs.existsSync(workspacePath) && fs.existsSync(newFormatPath);
    } else {
      const metadataPath = path.join(workspacePath, '.metadata');
      return fs.existsSync(workspacePath) && fs.existsSync(metadataPath);
    }
  }

  getDebugInfo(): object {
    return {
      workspacePath: this.config.workspacePath,
      connectionsFile: this.getConnectionsFilePath(),
      connectionsFileExists: fs.existsSync(this.getConnectionsFilePath()),
      credentialsFile: this.getCredentialsFilePath(),
      credentialsFileExists: fs.existsSync(this.getCredentialsFilePath()),
      workspaceValid: this.isWorkspaceValid(),
      isNewFormat: this.isNewFormat,
      platform: os.platform(),
      nodeVersion: process.version,
    };
  }

  /**
   * Load and decrypt credentials from the workspace's credentials-config.json
   */
  private async loadCredentials(connections: DatabaseConnection[]): Promise<void> {
    const credentialsFile = this.getCredentialsFilePath();

    if (!fs.existsSync(credentialsFile)) {
      if (this.config.debug) {
        console.warn(`Credentials file not found: ${credentialsFile}`);
      }
      return;
    }

    try {
      const encryptedData = fs.readFileSync(credentialsFile);
      const decryptedData = this.decryptCredentials(encryptedData);
      const credentials = JSON.parse(decryptedData);

      // Merge credentials into connections
      for (const connection of connections) {
        const connId = connection.id;

        // Look for credentials in the decrypted data
        if (credentials[connId]) {
          const connCreds = credentials[connId];

          // Extract credentials from the nested structure
          if (connCreds['#connection']) {
            const creds = connCreds['#connection'];

            if (creds.user) {
              connection.user = creds.user;
              if (!connection.properties) {
                connection.properties = {};
              }
              connection.properties.user = creds.user;
            }

            if (creds.password) {
              if (!connection.properties) {
                connection.properties = {};
              }
              connection.properties.password = creds.password;
            }
          }

          // SSH tunnel / jump host credentials. The exact secret key used for network handler
          // credentials isn't publicly documented, so we scan for any key that looks like it
          // belongs to a network handler (e.g. "#network/ssh_tunnel") and merge in whatever
          // user/password pair we find onto the final SSH hop.
          if (connection.sshTunnel) {
            this.mergeHandlerCredentials(connCreds, connection.sshTunnel);
          }
        }

        // When the tunnel config was resolved from a shared Network Profile rather than
        // embedded in the connection itself, its saved credentials (if any) live under a
        // separate top-level "profile:<name>" key in the credentials store.
        if (connection.sshTunnel?.profileName) {
          const profileCreds = credentials[`profile:${connection.sshTunnel.profileName}`];
          if (profileCreds) {
            this.mergeHandlerCredentials(profileCreds, connection.sshTunnel);
          }
        }

        // Fall back to environment variable overrides when the workspace didn't yield
        // usable SSH tunnel secrets (e.g. unrecognized credential key format, or a
        // key-file passphrase that DBeaver prompts for interactively rather than storing).
        if (connection.sshTunnel) {
          connection.sshTunnel.password =
            connection.sshTunnel.password || process.env.OMNISQL_SSH_PASSWORD;
          connection.sshTunnel.passphrase =
            connection.sshTunnel.passphrase || process.env.OMNISQL_SSH_PASSPHRASE;
          connection.sshTunnel.privateKeyPath =
            connection.sshTunnel.privateKeyPath || process.env.OMNISQL_SSH_PRIVATE_KEY_PATH;
        }
      }

      if (this.config.debug) {
        console.error(`Successfully loaded credentials for ${connections.length} connections`);
      }
    } catch (error) {
      if (this.config.debug) {
        console.error(`Failed to load credentials: ${error}`);
      }
      // Don't throw - continue without credentials
    }
  }

  /**
   * Merge any user/password/passphrase found in a credentials-store object into an
   * SSH tunnel config, without overwriting values already resolved elsewhere. Scans
   * for any key that looks like it belongs to a network handler (e.g. "#network/ssh_tunnel")
   * since the exact secret key naming isn't publicly documented.
   */
  private mergeHandlerCredentials(
    credsObject: Record<string, unknown>,
    sshTunnel: SSHTunnelConfig
  ): void {
    for (const [credKey, credValue] of Object.entries(credsObject)) {
      if (!/network|ssh_tunnel|ssh-tunnel/i.test(credKey)) continue;
      const handlerCreds = credValue as Record<string, string> | undefined;
      if (!handlerCreds) continue;

      if (handlerCreds.user && !sshTunnel.username) {
        sshTunnel.username = handlerCreds.user;
      }
      if (handlerCreds.password && !sshTunnel.password) {
        sshTunnel.password = handlerCreds.password;
      }
      if (handlerCreds.passphrase && !sshTunnel.passphrase) {
        sshTunnel.passphrase = handlerCreds.passphrase;
      }
    }
  }

  /**
   * Decrypt workspace credentials using AES-128-CBC.
   * The local DB client (DBeaver-compatible) uses a hardcoded key and IV for encryption.
   */
  private decryptCredentials(encryptedData: Buffer): string {
    try {
      const decipher = crypto.createDecipheriv('aes-128-cbc', WORKSPACE_AES_KEY, WORKSPACE_AES_IV);
      decipher.setAutoPadding(true);

      // Decrypt entire file, then drop the 16-byte header from the decrypted output
      let decrypted = decipher.update(encryptedData);
      decrypted = Buffer.concat([decrypted, decipher.final()]);

      const withoutHeader = decrypted.slice(16);
      return withoutHeader.toString('utf8');
    } catch (error) {
      throw new Error(`Failed to decrypt credentials: ${error}`);
    }
  }
}
