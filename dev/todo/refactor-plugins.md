# Refactor plugin architecture

**GitHub Issue:** https://github.com/mpilhlt/pdf-tei-editor/issues/119

Reorganize the existing layout

- app/src/plugins  
- app/src/modules
- app/src/templates

into

- app/src/plugins/plugin1/plugin1.js
- app/src/plugins/plugin1/plugin1.html
- app/src/plugins/plugin2/plugin2.js
- app/src/plugins/plugin2/plugin2.html
- app/src/plugins/plugin3/...
- app/src/lib/module1/...
- app/src/lib/module2/...
