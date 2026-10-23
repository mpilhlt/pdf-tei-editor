# Documentation site on GitHub Pages: build with Jekyll 4

## Problem

The built-in GitHub Pages run "pages build and deployment" ([run 39947750537](https://github.com/mpilhlt/pdf-tei-editor/actions/runs/39947750537)) failed on every push to `main` since Pages was enabled on 2026-10-20:

```text
Liquid Exception: Liquid syntax error (line 1169): Variable '{{page: number}' was not properly terminated with regexp: /\}\}/ in code-assistant/backend-plugins.md
```

The built-in build uses Jekyll 3.10 (github-pages gem 232), which renders every Markdown file as a Liquid template. A local reproduction with the same gem version found 14 files under `docs/` that abort the build (JSDoc types like `{{xml: string}}` and Python f-strings in code blocks) and 17 more that parse but lose their `{{ ... }}` snippets (mostly `${{ github.* }}` in workflow examples). Jekyll 3 has no option to switch Liquid off; front matter `render_with_liquid: false` exists only since Jekyll 4.

## Change

- `.github/workflows/pages.yml` builds `docs/` with Jekyll 4 and deploys it with `actions/deploy-pages`.
- `docs/_config.yml` sets `render_with_liquid: false` as a default for all pages and reproduces the classic Pages setup (Primer theme, optional front matter, relative links, titles from headings, kramdown GFM).
- `docs/Gemfile` / `docs/Gemfile.lock` pin the gems.
- `docs/development/ci-cd-pipeline.md` documents the workflow.

`jekyll-commonmark-ghpages` (the classic Pages Markdown processor) requires Jekyll 3, so the site uses kramdown with the GFM parser, as Jekyll 4 does by default.

## Manual step

Settings > Pages > Build and deployment > Source: "GitHub Actions". Until this is switched, GitHub keeps running the built-in Jekyll 3 build.

## Verification

Built `docs/` locally with the committed Gemfile and `--baseurl /pdf-tei-editor`: all 244 pages render, `backend-plugins.html` contains `{{page: number}|null}` and `ci-cd-pipeline.html` contains `${{ github.event.pull_request.number }}`. The local build ran without the Primer theme and `jekyll-seo-tag`, because `jekyll-github-metadata` needs GitHub API access that the build environment did not have; in Actions it uses `GITHUB_TOKEN`.
