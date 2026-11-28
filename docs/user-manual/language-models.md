# Choosing a language model

Several functions of the editor use a large language model (LLM), for example the LLM Reviewer (**Tools** > **Review document annotations**), the LLamore extractor and the automatic annotation. The models are provided by plugins: each LLM provider plugin, such as those for KISSKI, Anthropic Claude or Google Gemini, adds the models of its service. Which providers are available depends on your installation.

## The Inference menu

Open the <sl-icon name="tools"></sl-icon> **Tools** menu and point at the entry in the **Inference** section. It shows the provider and name of the model in use, or **Default Model** if no model is set. Its submenu lists the models you can use, grouped by provider, and the model in use is checked.

![The open Tools menu of an administrator. The Inference entry reads "KISSKI/llama-3.3-70b-instruct"; its submenu lists three KISSKI models, the first one checked, the second with a warning icon, each with a clipboard button, and "Add your API key…" under Google Gemini](../images/language-models-menu.png)

*The models of two providers in the Tools menu. The second model is busy, and Google Gemini needs the user's own API key.*

- A warning icon after a model means that the provider reports it as busy or unavailable at the moment. Hover over the icon to see its status.
- An <sl-icon name="eye"></sl-icon> eye icon after a model means that it accepts images (a vision model). The review of OCR errors then also sends it the images of the pages, so it can compare the text with the scan. Whether a model accepts images is reported by its provider: KISSKI reports it for each model; Anthropic and Google Gemini models accept images; for an inference endpoint, the administrator sets it.
- **Add your API key…** under a provider means that the provider runs on your own API key, which you have not entered yet. Selecting it opens the API key dialog (see [Your own API keys](#your-own-api-keys)).
- **Models unavailable** means that the provider could not list its models; hover over it to see the error. If the provider uses your own key, selecting the entry opens the API key dialog, since a wrong key is the usual cause.

## The default model and your own choice

The **default model** is the model everyone uses unless they choose another one. Only administrators can set it: when an administrator selects a model, the editor asks whether to make it the default model for all users.

Other users can choose another model for themselves, for example when the default model is busy. A message confirms the choice. It applies in the current browser tab until you log out or close the tab; then the default model applies again.

Which models you see depends on your role and on your installation:

- Administrators see all models the installation offers. They can restrict the models of providers that run on a shared key for everyone, for example to models of particular providers.
- Other users see the models marked as free by their provider or by the administrator, plus the default model. Models that cost money per request are therefore only available if an administrator made one of them the default model.
- The models of providers that run on your own API key are all listed for you, since you pay for them yourself.

Administrators also see a clipboard button next to each model, which copies its full id (`<provider>/<model>`, for example `kisski/llama-3.3-70b-instruct`) for use in scripts.

## Your own API keys

Some providers need an API key of your own, so that the cost of the requests is billed to you. Enter your keys under **API Keys** in the user menu, or in the dialog that appears when a function needs a key that is missing. The keys are stored encrypted on the server. **Remove all keys** in the dialog removes all your keys at once. Where to get a key is described on the page of the provider plugin below, if your installation has one.

## Language model plugins

<!-- plugin-docs: inference hide-heading -->
