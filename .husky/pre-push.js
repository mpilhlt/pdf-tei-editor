import { execSync } from 'child_process';

try {
  // Run smart tests first - fail fast if tests don't pass
  console.log('Running smart tests...');
  execSync('node app/src/modules/smart-test-runner.js', { stdio: 'inherit' });
  console.log('Tests passed.');
} catch (e) {
  console.error('Pre-push hook failed: Tests did not pass.', e.message);
  process.exit(1);
}
