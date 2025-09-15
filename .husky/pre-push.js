import { execSync } from 'child_process';

try {
  // Check if the latest commit message contains [skip-ci] or [skip ci]
  const latestCommitMessage = execSync('git log -1 --pretty=%B', { encoding: 'utf8' }).trim();

  if (latestCommitMessage.match(/\[(skip-ci|skip ci)\]/i)) {
    console.log('⏭️  Skipping tests due to [skip-ci] in commit message.');
    process.exit(0);
  }

  // Run smart tests first - fail fast if tests don't pass
  console.log('Running smart tests...');
  execSync('node tests/smart-test-runner.js', { stdio: 'inherit' });
  console.log('Tests passed.');
} catch (e) {
  console.error('Pre-push hook failed: Tests did not pass.', e.message);
  process.exit(1);
}
