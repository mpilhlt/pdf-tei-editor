import { execSync } from 'child_process';

/**
 * Detect available container tool (podman or docker) with compose support
 *
 * @returns {{containerCmd: string, composeCmd: string, usePodman: boolean}}
 * @throws {Error} If neither docker nor podman is available
 */
export function detectContainerTool() {
  try {
    execSync('command -v podman', { stdio: 'ignore' });

    // Check for compose tools
    let composeCmd = null;
    try {
      execSync('command -v podman-compose', { stdio: 'ignore' });
      composeCmd = 'podman-compose';
    } catch {
      try {
        execSync('command -v docker-compose', { stdio: 'ignore' });
        composeCmd = 'docker-compose';
      } catch {
        // No compose tool found
      }
    }

    return {
      containerCmd: 'podman',
      composeCmd,
      usePodman: true
    };
  } catch {
    try {
      execSync('command -v docker', { stdio: 'ignore' });

      // Check for docker compose
      let composeCmd = null;
      try {
        execSync('docker compose version', { stdio: 'ignore' });
        composeCmd = 'docker compose';
      } catch {
        try {
          execSync('command -v docker-compose', { stdio: 'ignore' });
          composeCmd = 'docker-compose';
        } catch {
          throw new Error('Docker Compose is required but not installed');
        }
      }

      return {
        containerCmd: 'docker',
        composeCmd,
        usePodman: false
      };
    } catch {
      throw new Error('Neither podman nor docker found. Please install one of them.');
    }
  }
}
