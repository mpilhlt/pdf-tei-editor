#!/usr/bin/env node

/**
 * Release script for creating patch, minor, and major version releases.
 *
 * Must be run from the devel branch. After tagging, create a PR to merge devel into main.
 * See docs/development/contributing.md#release-process for workflow details.
 *
 * Usage:
 *   node bin/release.js patch                  # Bump patch version (0.7.0 -> 0.7.1)
 *   node bin/release.js minor                  # Bump minor version (0.7.0 -> 0.8.0)
 *   node bin/release.js major                  # Bump major version (0.7.0 -> 1.0.0)
 *   node bin/release.js patch --dry-run        # Test without pushing
 *   node bin/release.js minor --skip-tests     # Skip test execution
 */

import { execSync } from 'child_process';
import { readFileSync } from 'fs';

const VALID_TYPES = ['patch', 'minor', 'major'];
let DRY_RUN = false;
let SKIP_TESTS = false;

/**
 * Execute command and return output
 * @param {string} command - Command to execute
 * @param {boolean} silent - Whether to suppress output
 * @param {boolean} skipInDryRun - Skip command in dry-run mode
 * @param {boolean} throwOnError - Throw instead of exiting on error
 * @returns {string} Command output
 */
function exec(command, silent = false, skipInDryRun = false, throwOnError = false) {
  if (DRY_RUN && skipInDryRun) {
    console.log(`[DRY RUN] Would execute: ${command}`);
    return '';
  }

  try {
    const result = execSync(command, {
      encoding: 'utf8',
      stdio: silent ? 'pipe' : 'inherit'
    });
    return result ? result.trim() : '';
  } catch (error) {
    if (throwOnError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Command failed: ${command}`);
    console.error(message);
    process.exit(1);
  }
}

/**
 * Get current branch name
 * @returns {string} Current branch name
 */
function getCurrentBranch() {
  return exec('git rev-parse --abbrev-ref HEAD', true);
}

/**
 * Get current version from package.json
 * @returns {string} Current version
 */
function getCurrentVersion() {
  const pkg = JSON.parse(readFileSync('./package.json', 'utf8'));
  return pkg.version;
}

/**
 * Check if working directory is clean
 * @returns {boolean} True if clean
 */
function isWorkingDirectoryClean() {
  const status = exec('git status --porcelain', true);
  return status.length === 0;
}

/**
 * Main release function
 * @param {string} releaseType - Type of release (patch, minor, major)
 */
function release(releaseType) {
  if (DRY_RUN) {
    console.log(`\n🧪 DRY RUN MODE - No changes will be pushed\n`);
  }
  console.log(`\n🚀 Starting ${releaseType} release process...\n`);

  // Validate release type
  if (!VALID_TYPES.includes(releaseType)) {
    console.error(`❌ Invalid release type: ${releaseType}`);
    console.error(`   Valid types: ${VALID_TYPES.join(', ')}`);
    process.exit(1);
  }

  // Check current branch
  const currentBranch = getCurrentBranch();
  console.log(`📍 Current branch: ${currentBranch}`);

  // Enforce release from devel, not main
  if (currentBranch === 'main') {
    console.error('❌ Cannot create releases from main branch.');
    console.error('');
    console.error('Recommended workflow:');
    console.error('  1. git checkout devel');
    console.error('  2. node bin/release.js patch  # or minor/major');
    console.error('  3. Create PR to merge devel into main');
    console.error('  4. Merge PR after tests pass');
    console.error('  5. Release and Docker build happen automatically');
    console.error('');
    console.error('See docs/development/contributing.md#release-process for details.');
    process.exit(1);
  }

  // Check for uncommitted changes
  if (!isWorkingDirectoryClean()) {
    console.error('❌ Working directory is not clean. Please commit or stash changes first.');
    process.exit(1);
  }

  // Get current version
  const currentVersion = getCurrentVersion();
  console.log(`📦 Current version: ${currentVersion}`);

  // Ensure we're up to date with remote
  console.log('\n📥 Fetching latest changes from remote...');
  exec('git fetch origin');

  // Use current branch for release
  const releaseBranch = currentBranch;
  console.log(`\n✅ Using current branch: ${releaseBranch}`);

  // Run tests
  if (SKIP_TESTS) {
    console.log('\n⚠️  Skipping tests (--skip-tests flag provided)');
  } else {
    // Get files changed since last release tag
    let changedFilesSinceLastTag;
    try {
      const lastTag = exec('git describe --tags --abbrev=0', true, false, true);
      if (lastTag) {
        console.log(`\n🧪 Running tests for files changed since ${lastTag}...`);
        changedFilesSinceLastTag = exec(`git diff --name-only ${lastTag} HEAD`, true);
      } else {
        console.log('\n🧪 No previous release tag found, running all tests...');
        changedFilesSinceLastTag = '';
      }
    } catch {
      console.log('\n🧪 Could not determine last release tag, running all tests...');
      changedFilesSinceLastTag = '';
    }

    try {
      if (changedFilesSinceLastTag) {
        // Pass changed files to smart test runner
        const files = changedFilesSinceLastTag.split('\n').filter(f => f.trim()).join(' ');
        exec(`node tests/smart-test-runner.js ${files}`);
      } else {
        // Run all tests if we can't determine changed files
        exec('npm run test:all');
      }
      console.log('✅ All tests passed');
    } catch (error) {
      console.error('❌ Tests failed. Cannot proceed with release.');
      process.exit(1);
    }
  }

  // Generate API client to ensure it's up to date
  console.log('\n🔄 Generating API client...');
  exec('npm run generate-client');

  // Check if API client was changed after generation
  const apiClientStatus = exec('git status --porcelain app/src/modules/api-client-v1.js', true);
  if (apiClientStatus.length > 0) {
    console.log('⚠️  API client was regenerated. Committing changes...');
    exec('git add app/src/modules/api-client-v1.js', false, true);
    exec('git commit -m "Update API client before release"', false, true);
  }

  // Bump version using npm version command
  console.log(`\n⬆️  Bumping ${releaseType} version...`);
  exec(`npm version ${releaseType} -m "chore(release): v%s"`, false, true);

  // Get new version (in dry-run, simulate the version bump)
  let newVersion;
  if (DRY_RUN) {
    const [major, minor, patch] = currentVersion.split('.').map(Number);
    if (releaseType === 'major') {
      newVersion = `${major + 1}.0.0`;
    } else if (releaseType === 'minor') {
      newVersion = `${major}.${minor + 1}.0`;
    } else {
      newVersion = `${major}.${minor}.${patch + 1}`;
    }
  } else {
    newVersion = getCurrentVersion();
  }
  console.log(`✅ Version bumped: ${currentVersion} → ${newVersion}`);

  // Push the branch and tags
  console.log('\n📤 Pushing changes to remote...');
  exec(`git push --follow-tags origin ${releaseBranch}`, false, true);

  // Show next steps
  console.log('\n✅ Release tagged successfully!');
  console.log(`   Tag v${newVersion} has been created and pushed`);
  console.log('\n📝 Next steps:');
  console.log('   1. Create PR to merge devel into main');
  console.log('   2. Wait for PR tests to pass');
  console.log('   3. Merge the PR');
  console.log('   4. GitHub Actions will automatically:');
  console.log('      - Create GitHub release with changelog');
  console.log('      - Build and push Docker image');

  if (DRY_RUN) {
    console.log('\n🧪 DRY RUN COMPLETE - No changes were pushed\n');
  } else {
    console.log('\n🎉 Release process complete!\n');
  }
}

// Parse command line arguments
const args = process.argv.slice(2);
const releaseType = args[0];
const dryRunFlag = args.includes('--dry-run');
const skipTestsFlag = args.includes('--skip-tests');

if (!releaseType) {
  console.error('\n❌ Missing release type argument\n');
  console.error('Usage:');
  console.error('  node bin/release.js patch                  # Bump patch version (0.7.0 -> 0.7.1)');
  console.error('  node bin/release.js minor                  # Bump minor version (0.7.0 -> 0.8.0)');
  console.error('  node bin/release.js major                  # Bump major version (0.7.0 -> 1.0.0)');
  console.error('  node bin/release.js patch --dry-run        # Test without pushing');
  console.error('  node bin/release.js minor --skip-tests     # Skip test execution\n');
  console.error('');
  process.exit(1);
}

// Set flags
DRY_RUN = dryRunFlag;
SKIP_TESTS = skipTestsFlag;

// Run release
release(releaseType);
