// Types only: shared/ holds what the main process and the renderer both need.


/** The machines a download can go to besides this PC. */
export interface DownloadHosts {
  /** The model controller is running. */
  inUse: boolean;
  /** This controller's machine name. */
  local: string | null;
  /** The other machines. */
  hosts: string[];
}
