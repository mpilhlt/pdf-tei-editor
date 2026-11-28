# Page images for vision models in the OCR error review

Issue #960. When the selected model accepts images, the LLM review of OCR errors also sends the images of the reviewed pages, so that the model can compare the text with the scan.

## Changes

- `lib/llm/base.py`: `VISION_CAPABILITY = "vision"`. The default `supports_image_input()` derives from the capabilities `list_models()` reports (False if listing fails), so `capabilities` and `supports_image_input()` agree.
- `lib/llm/openai_compatible.py`: `user_content()` builds `image_url` data-URL parts; `chat_completion_sync(images=...)` and `OpenAICompatibleProvider.chat_completion_with_images()` (KISSKI inherits it).
- `lib/llm/review_call.py`: `complete_with_retry(images=...)` sends the images with the first call and the retry.
- `lib/ocr/page_images.py`: `render_page_images()` renders pages with pypdfium2 as grayscale JPEGs, longer edge at most 1800 px.
- `lib/ocr/line_review.py`: system prompt note when images are attached; `review_lines_window(images=...)`.
- `lib/ocr/llm_correction.py`: checks once per run (`CorrectionRun.page_images`), renders each window's pages, falls back to text if rendering fails; the run message names the page images.
- `/ocr/llm-review`: renders the window's pages from the TEI's PDF (`_review_images()`), text only if there is no readable PDF; response field `page_images`.
- Inference menu: eye icon with tooltip for models with the `vision` capability.

## Providers (pte-plugins)

KISSKI reads `input` modalities from `/models`; Anthropic and Gemini chat models report `vision`, Gemini implements `chat_completion_with_images()`; MPCDF presets carry a new `vision` field (llm-mpcdf 717dae0), set with "Accepts images" in the preset form.
