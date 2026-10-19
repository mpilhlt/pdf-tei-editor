# LLamore Extractor Plugin

Registers an extractor that extracts bibliographic references from PDFs with the [LLamore](https://github.com/mpilhlt/llamore) library and produces a TEI document with `<biblStruct>` elements.

The plugin has no menu entries; the extractor is used through the extraction dialog and `/api/v1/extract`.

## How It Works

1. Resolves the LLM provider and model: `provider_id`/`model_id` from the extraction options (the client sends the model chosen under Tools > Default Model), otherwise the installation-wide default model. Model access is checked for the requesting user.
2. Resolves the additional prompt instructions: the user's selected override, otherwise the shipped [prompts/additional-instructions.md](prompts/additional-instructions.md). The instructions are recorded as an `additional-instructions` entry in the document's `<editorialDecl>`.
3. Sends the prompt to the provider. Providers that accept PDF input get the PDF itself; for the others the PDF's text layer (via pypdf) is sent. A PDF without a text layer fails for such providers.
4. Parses the response with LLamore's `LineByLinePrompter` and serializes it with `TeiBiblStruct`. Header metadata is looked up via DOI when one is given.

## Extractor

- Extractor ID: `llamore-gemini` (kept for compatibility with stored configs and scripts; the extractor works with any registered LLM provider)
- Input: PDF; output: TEI document
- Variants: `llamore-default` (schema `https://mpilhlt.github.io/llamore/schema/llamore-default.rng`)
- Options: `doi`, `variant_id`
- Available when at least one LLM provider is registered, for example by the [Anthropic](../anthropic_llm/README.md), [Google](../google_llm/README.md) or [KISSKI](../kisski/README.md) plugins

## Implementation

- **Plugin file**: [plugin.py](plugin.py) - registers the extractor and a `DocumentRulesProvider` for "Refresh document rules"
- **Extractor**: [extractor.py](extractor.py)
- **Configuration**: [config.py](config.py) - variants, form options, navigation XPath, annotation guide URLs
- **Tests**: [tests/](tests/)

## Technical Details

- Category: `extractor`
- Requires: User role or higher
