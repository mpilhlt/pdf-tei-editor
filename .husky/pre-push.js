import { execSync } from 'child_process';

try {
  // Run smart tests first - fail fast if tests don't pass
  console.log('Running smart tests...');
  execSync('node app/src/modules/smart-test-runner.js', { stdio: 'inherit' });
  console.log('Tests passed. Running build...');
  
  // Run build
  execSync('npm run build', { stdio: 'inherit' });
  
  // Check if build created any changes and commit them
  const status = execSync('git status --porcelain', { encoding: 'utf8' });
  if (status.trim()) {
    console.log('Build created changes, committing them...');
    execSync('git add -A');
    execSync('git commit -m "Update build files"');
  } else {
    console.log('No build changes to commit');
  }
} catch (e) {
  console.error('Pre-push hook failed:', e.message);
  process.exit(1);
}