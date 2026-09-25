#!/bin/bash

# Setup branch protection rules for PDF TEI Editor repository
# This script installs GitHub CLI if needed, installs the gh-branch-rules extension,
# and configures branch protection for main and devel branches

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Print colored message
print_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

print_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Check if gh CLI is installed
check_gh_installed() {
    if command -v gh &> /dev/null; then
        print_info "GitHub CLI (gh) is already installed: $(gh --version | head -n1)"
        return 0
    else
        print_warn "GitHub CLI (gh) is not installed"
        return 1
    fi
}

# Install gh CLI
install_gh() {
    print_info "Installing GitHub CLI..."

    case "$(uname -s)" in
        Darwin*)
            if command -v brew &> /dev/null; then
                brew install gh
            else
                print_error "Homebrew is required to install gh on macOS"
                print_error "Visit https://cli.github.com/ for manual installation"
                exit 1
            fi
            ;;
        Linux*)
            if command -v apt-get &> /dev/null; then
                sudo apt-get update
                sudo apt-get install -y gh
            elif command -v yum &> /dev/null; then
                sudo yum install -y gh
            else
                print_error "Could not detect package manager"
                print_error "Visit https://cli.github.com/ for manual installation"
                exit 1
            fi
            ;;
        *)
            print_error "Unsupported operating system: $(uname -s)"
            print_error "Visit https://cli.github.com/ for manual installation"
            exit 1
            ;;
    esac

    print_info "GitHub CLI installed successfully"
}

# Note: We're using GitHub REST API directly instead of gh-branch-rules extension
# The extension has issues with CSV parsing and applying rules

# Check if user is authenticated
check_gh_auth() {
    if gh auth status &> /dev/null; then
        print_info "GitHub CLI is authenticated"
        return 0
    else
        print_error "GitHub CLI is not authenticated"
        print_error "Please run: gh auth login"
        exit 1
    fi
}

# Get repository information
get_repo_info() {
    cd "$REPO_ROOT"

    # Get owner and repo name from git remote
    local remote_url=$(git config --get remote.origin.url)

    if [[ $remote_url =~ github.com[:/]([^/]+)/([^/.]+) ]]; then
        REPO_OWNER="${BASH_REMATCH[1]}"
        REPO_NAME="${BASH_REMATCH[2]}"
        print_info "Repository: $REPO_OWNER/$REPO_NAME"
    else
        print_error "Could not parse GitHub repository from remote URL: $remote_url"
        exit 1
    fi
}

# Apply protection to main branch
protect_main_branch() {
    print_info "Applying protection to main branch..."

    local config=$(cat <<'EOF'
{
  "required_pull_request_reviews": {
    "required_approving_review_count": 1,
    "dismiss_stale_reviews": false,
    "require_code_owner_reviews": false
  },
  "restrictions": null,
  "required_status_checks": null,
  "enforce_admins": false,
  "allow_deletions": false,
  "allow_force_pushes": false,
  "block_creations": false,
  "required_conversation_resolution": false,
  "lock_branch": false,
  "required_linear_history": false
}
EOF
)

    echo "$config" | gh api \
        --method PUT \
        "repos/$REPO_OWNER/$REPO_NAME/branches/main/protection" \
        --input - > /dev/null

    print_info "Main branch protection applied"
}

# Apply protection to devel branch
protect_devel_branch() {
    print_info "Applying protection to devel branch..."

    local config=$(cat <<'EOF'
{
  "required_pull_request_reviews": null,
  "restrictions": null,
  "required_status_checks": null,
  "enforce_admins": false,
  "allow_deletions": false,
  "allow_force_pushes": false,
  "block_creations": false,
  "required_conversation_resolution": false,
  "lock_branch": false,
  "required_linear_history": false
}
EOF
)

    echo "$config" | gh api \
        --method PUT \
        "repos/$REPO_OWNER/$REPO_NAME/branches/devel/protection" \
        --input - > /dev/null

    print_info "Devel branch protection applied"
}

# Verify branch protection rules
verify_rules() {
    print_info "Verifying branch protection rules..."

    echo ""
    print_info "Main branch protection:"
    gh api "repos/$REPO_OWNER/$REPO_NAME/branches/main/protection" 2>/dev/null || print_warn "No protection rules found for main branch"

    echo ""
    print_info "Devel branch protection:"
    gh api "repos/$REPO_OWNER/$REPO_NAME/branches/devel/protection" 2>/dev/null || print_warn "No protection rules found for devel branch"
}

# Main function
main() {
    echo "PDF TEI Editor - Branch Protection Setup"
    echo "========================================"
    echo ""

    # Check and install gh CLI if needed
    if ! check_gh_installed; then
        install_gh
    fi

    # Check authentication
    check_gh_auth

    # Get repository information
    get_repo_info

    # Apply protection rules
    protect_main_branch
    protect_devel_branch

    # Verify
    verify_rules

    echo ""
    print_info "✅ Branch protection setup completed!"
    echo ""
    print_info "Configuration:"
    print_info "  - main branch: Requires pull request reviews (1 approval), cannot be deleted or force-pushed"
    print_info "  - devel branch: Cannot be deleted or force-pushed"
    echo ""
    print_info "To view rules in GitHub web interface:"
    print_info "  https://github.com/$REPO_OWNER/$REPO_NAME/settings/branches"
    echo ""
}

# Run main function
main "$@"
