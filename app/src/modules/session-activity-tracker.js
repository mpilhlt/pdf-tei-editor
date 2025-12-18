/**
 * Session Activity Tracker Module
 *
 * Monitors user activity and triggers automatic logout before session expires.
 * Uses industry best practice: warn at 80% of timeout, logout at 95%.
 *
 * Activity is detected from:
 * - Mouse movements
 * - Keyboard input
 * - Touch events
 * - Click events
 */

/** @import { Logger } from './logger.js' */

/**
 * @typedef {Object} SessionActivityTrackerOptions
 * @property {number} sessionTimeout - Session timeout in seconds
 * @property {() => Promise<void>} onLogout - Callback to execute on automatic logout
 * @property {Logger} [logger] - Logger instance
 * @property {number} [warningThreshold=0.8] - Percentage of timeout before warning (0-1)
 * @property {number} [logoutThreshold=0.95] - Percentage of timeout before auto-logout (0-1)
 */

/**
 * Session Activity Tracker
 *
 * Tracks user activity and automatically logs out before session expires on the server.
 * Best practice: logout at 95% of session timeout to prevent unexpected errors.
 */
export class SessionActivityTracker {
  /**
   * @param {SessionActivityTrackerOptions} options
   */
  constructor(options) {
    this.sessionTimeout = options.sessionTimeout * 1000; // Convert to milliseconds
    this.onLogout = options.onLogout;
    this.logger = options.logger;
    this.warningThreshold = options.warningThreshold ?? 0.8;
    this.logoutThreshold = options.logoutThreshold ?? 0.95;

    this.lastActivityTime = Date.now();
    this.warningShown = false;
    this.checkInterval = null;
    this.activityListeners = [];

    this._setupActivityListeners();
    this._startMonitoring();
  }

  /**
   * Setup event listeners for user activity
   * @private
   */
  _setupActivityListeners() {
    const activityHandler = () => this._recordActivity();

    // Events to track
    const events = ['mousedown', 'mousemove', 'keydown', 'scroll', 'touchstart', 'click'];

    events.forEach(eventType => {
      // Use capture phase and passive listeners for better performance
      const options = { capture: true, passive: true };
      document.addEventListener(eventType, activityHandler, options);
      this.activityListeners.push({ eventType, handler: activityHandler, options });
    });
  }

  /**
   * Record user activity
   * @private
   */
  _recordActivity() {
    this.lastActivityTime = Date.now();
    this.warningShown = false;
  }

  /**
   * Start monitoring session timeout
   * @private
   */
  _startMonitoring() {
    // Check every 10 seconds
    this.checkInterval = setInterval(() => {
      this._checkSessionTimeout();
    }, 10000);
  }

  /**
   * Check if session is close to expiring
   * @private
   */
  async _checkSessionTimeout() {
    const now = Date.now();
    const timeSinceActivity = now - this.lastActivityTime;
    const timeoutThreshold = this.sessionTimeout * this.logoutThreshold;
    const warningThreshold = this.sessionTimeout * this.warningThreshold;

    // Auto-logout at 95% of session timeout
    if (timeSinceActivity >= timeoutThreshold) {
      this.logger?.info(`Session timeout reached (${Math.round(timeSinceActivity / 1000)}s of inactivity). Auto-logging out.`);
      await this._performAutoLogout();
      return;
    }

    // Show warning at 80% of session timeout
    if (timeSinceActivity >= warningThreshold && !this.warningShown) {
      const remainingSeconds = Math.round((this.sessionTimeout - timeSinceActivity) / 1000);
      this.logger?.warn(`Session will expire in ${remainingSeconds} seconds due to inactivity.`);
      this.warningShown = true;
    }
  }

  /**
   * Perform automatic logout
   * @private
   */
  async _performAutoLogout() {
    this.stop();
    try {
      await this.onLogout();
    } catch (error) {
      this.logger?.error('Error during automatic logout: ' + String(error));
    }
  }

  /**
   * Stop monitoring and cleanup
   */
  stop() {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }

    // Remove all activity listeners
    this.activityListeners.forEach(({ eventType, handler, options }) => {
      document.removeEventListener(eventType, handler, options);
    });
    this.activityListeners = [];
  }

  /**
   * Reset activity timer (call after successful API calls)
   */
  resetActivity() {
    this._recordActivity();
  }

  /**
   * Update session timeout (call when config changes)
   * @param {number} newTimeout - New timeout in seconds
   */
  updateTimeout(newTimeout) {
    this.sessionTimeout = newTimeout * 1000;
    this._recordActivity(); // Reset activity on timeout change
    this.logger?.debug(`Session timeout updated to ${newTimeout} seconds`);
  }
}
