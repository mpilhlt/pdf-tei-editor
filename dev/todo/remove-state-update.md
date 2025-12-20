# Replace `{state: {update}}` endpoints with `{onUpdateState}` in plugins

**GitHub Issue:** https://github.com/mpilhlt/pdf-tei-editor/issues/128

@app/src/endpoints.js

All of the non-class-based plugins in `app/src/plugins` still use the legacy endpoint `state.update` and should be migrated to the new reactive `onStateUpdate` endpoint.

Find all occurrences and replace with the equivalent code as follows. Then remove the legacy endpoint calling code and any mentions of it in the docs.

## 1. rewrite functions

Replace:

```javascript
/**
 *
 * @param {ApplicationState} state
 * @returns {Promise<void>}
 */
async function update(state) {
    //...
}
```

with:

```javascript
/**
 * Called when application state changes
 * @param {(keyof ApplicationState)[]} changedKeys
 * @param {ApplicationState} state
 */
async onStateUpdate(changedKeys, state) {
    //...
}
```

## 2. replace plugin endpoint definition

Replace:

```javascript
const plugin = {
    // ...
    state: {
        update
    }
    // ...
}
```

with:

```javascript
const plugin = {
  // ...
  onStateUpdate
  // ...
}
```
