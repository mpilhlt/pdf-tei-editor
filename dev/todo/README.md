# Code Assistant Tasks

This directory contains tasks for the code assistant comprising

- bug fixes
- new features
- feature enhancements
- code reorganization
- documentation improvements
- etc.

For each file in this folder, create an issue on GitHub using the `gh` tool if one doesn't exist already.

- Add a note at the beginning of the file linking to the GitHub issue, for reference and in order to prevent creating duplicate issues.

- Respect stated dependencies, i.e. create issues for parent tasks first and also make the issues dependent on each other.

- Set the "Issue type"  the issue as "bug", "feature", or "task", and tag the issue with the labels "python", "javascript", "documentation", "ci", or "schema", as applicable.

- In the issue, summarize the task and reference the file with its static github URL. Assign it to `@cboulanger`.

- While working on the task, add summaries of what you have implemented to the file. If the tasks is complex and involves multiple sessions and commits, reference the issue in the commit message.

- After you are done with each task, move it to `../done` and in the commit message, statically reference the file at its new location and mark the issue as fixed.

- DO NOT manually close the issue - it should be closed when the commmit is pushed.


