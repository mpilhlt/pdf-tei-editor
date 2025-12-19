# UI to edit file metadata

## Current state

- TEI metadata is read from parsing output, is then stored in the database
- TEI header can be manually changed but this won't update the metadata in the database

## Goal

- Implement a UI to edit TEI metadata. The updated values will be written to the header and updated in the database.
- This will allow to rename a file, change "gold" status, etc. 

## Implementation details

- new dialog with all the metadata properties currently parsed from the TEI, plus other properties that are only in the database.
- when submitted updates the xml locally and saves it, and calls an API endpoint to update the database.

## Special case: gold status

- "Gold" status should not be configured here, but in the "Revision Change" dialog. Users with the "reviewer" role should see an additional  button "Save as Gold Version" which, after a confirmation, will make the current version the Gold version (and remove the status from the current "gold")