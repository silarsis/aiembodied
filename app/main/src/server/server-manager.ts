import type { Logger } from 'winston';

/**
 * Represents a server's runtime state
 */
export interface ServerState {
  id: string;
  label: string;
  url: string;
  pid: number | null;
  wasRunning: boolean;
}

/**
 * Manages local model servers with suspend/resume support for hibernation
 */
export class ServerManager {
  private runningServers: Map<string, ServerState> = new Map();
  private suspended = false;
  private logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  /**
   * Capture which servers are currently running
   * This is used to restore state after resume
   */
  async captureRunningServers(): Promise<Map<string, ServerState>> {
    this.logger.debug('ServerManager: capturing server states');
    
    // For now, this is a placeholder that captures the current state
    // In a full implementation, you'd:
    // 1. Get the list of services from the app's configuration
    // 2. Check each server's health endpoint
    // 3. Store the PID and state
    
    // For testing purposes, return the current tracking map
    return this.runningServers;
  }

  /**
   * Called when system is about to suspend (best-effort, ~2s window)
   * Stop all running servers quickly
   */
  async suspend(): Promise<void> {
    if (this.suspended) {
      this.logger.debug('ServerManager: already suspended');
      return;
    }

    this.logger.info('ServerManager: suspending servers before hibernation');
    const startTime = Date.now();

    try {
      // Capture current state before stopping
      await this.captureRunningServers();

      // Stop servers in order (LLM first due to large memory footprint)
      const serverIds = Array.from(this.runningServers.keys());
      
      // Stop all servers (graceful first, then force)
      const stopPromises = serverIds.map(async (id) => {
        const server = this.runningServers.get(id);
        if (!server) return;

        try {
          this.logger.info(`ServerManager: stopping ${server.label}`);
          await this.stopServer(id);
          server.wasRunning = true;
        } catch (error) {
          this.logger.warn(`ServerManager: failed to stop ${server.label}`, {
            message: error instanceof Error ? error.message : String(error),
          });
        }
      });

      // Wait for all stops with a timeout (1.5s max)
      await Promise.race([
        Promise.all(stopPromises),
        new Promise<void>((_, reject) => 
          setTimeout(() => reject(new Error('Server stop timeout')), 1500)
        ),
      ]);
    } catch (error) {
      this.logger.warn('ServerManager: suspend completed with timeout/error', {
        message: error instanceof Error ? error.message : String(error),
      });
    }

    this.suspended = true;
    this.logger.info('ServerManager: suspension complete', { durationMs: Date.now() - startTime });
  }

  /**
   * Called when system resumes from suspend
   * Servers are not automatically restarted - they'll be managed by the app's existing
   * service management when needed.
   */
  async resume(): Promise<void> {
    if (!this.suspended) {
      this.logger.debug('ServerManager: not suspended, skipping resume');
      return;
    }

    this.logger.info('ServerManager: resume complete - servers will be managed on next use');
    
    // Clear tracking - servers will be started as needed by the app
    this.runningServers.clear();
    this.suspended = false;
  }

  /**
   * Hibernation: stop all servers and prepare for hibernation
   * This is called when the user explicitly requests hibernation
   */
  async hibernate(): Promise<void> {
    this.logger.info('ServerManager: hibernation sequence started');
    
    // Stop all running servers
    await this.suspend();
    
    // Clear tracking - servers will be auto-started on first use after hibernation
    this.runningServers.clear();
    
    this.logger.info('ServerManager: hibernation sequence complete');
  }

  /**
   * Stop a specific server by ID
   * Returns true if the server was running and stopped
   */
  async stopServer(id: string): Promise<boolean> {
    // This is a placeholder implementation
    // In a real implementation, you'd:
    // 1. Get the server's PID
    // 2. Kill the process
    // 3. Verify it's stopped
    
    const server = this.runningServers.get(id);
    if (!server) {
      this.logger.debug(`ServerManager: server ${id} not in tracking list`);
      return false;
    }

    this.logger.info(`ServerManager: stopping server ${id} (${server.label})`);
    
    // For now, just mark as stopped
    server.pid = null;
    return true;
  }

  /**
   * Start a specific server by ID
   * Returns true if the server was started or was already running
   */
  async startServer(id: string): Promise<boolean> {
    // This is a placeholder implementation
    // In a real implementation, you'd:
    // 1. Check if the server is already running
    // 2. If not, start it using the same logic as ensureLocalServices()
    // 3. Update the tracking state
    
    this.logger.info(`ServerManager: starting server ${id}`);
    
    // Mark as running (in real implementation, you'd actually start it)
    const server = this.runningServers.get(id);
    if (server) {
      server.wasRunning = true;
    }
    
    return true;
  }

  /**
   * Check if a specific server is running
   */
  async isServerRunning(id: string): Promise<boolean> {
    // This is a placeholder implementation
    // In a real implementation, you'd probe the server's health endpoint
    
    const server = this.runningServers.get(id);
    if (!server) {
      this.logger.debug(`ServerManager: server ${id} not in tracking list`);
      return false;
    }
    
    // For now, assume it's running if we have a PID
    return server.pid !== null;
  }

  /**
   * Get the current state of all tracked servers
   */
  getServerStates(): ServerState[] {
    return Array.from(this.runningServers.values());
  }

  /**
   * Add a server to the manager's tracking list
   */
  addServer(state: ServerState): void {
    this.runningServers.set(state.id, { ...state, wasRunning: false });
    this.logger.debug(`ServerManager: added server ${state.id}`);
  }

  /**
   * Remove a server from tracking
   */
  removeServer(id: string): void {
    this.runningServers.delete(id);
    this.logger.debug(`ServerManager: removed server ${id}`);
  }

  /**
   * Clear all tracked servers (used for testing)
   */
  clear(): void {
    this.runningServers.clear();
    this.suspended = false;
  }
}
