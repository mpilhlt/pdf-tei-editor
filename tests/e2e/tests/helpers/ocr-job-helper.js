/**
 * Stand-ins for the OCR jobs in E2E tests without an OCR engine: a submit to `POST /api/v1/ocr`
 * or `POST /api/v1/ocr/llm-correction` is answered with a real `test.progress` job of the server,
 * so the job events, the progress widget (`job-<id>`), cancel and `jobs.wait()` are those of a
 * real job, while its progress and result are given by the test.
 */

/**
 * @import { Page, Route } from '@playwright/test'
 */

/**
 * Parameters of the stand-in job (see `ProgressTestParams` in fastapi_app/lib/jobs/core_types.py)
 * @typedef {object} StandInJob
 * @property {number} [steps] - Number of progress reports
 * @property {number} [delay_ms] - Milliseconds before each report
 * @property {string} [phase] - Phase of the reports, e.g. 'Recognizing text'
 * @property {string} [unit] - Unit of the reports, e.g. 'page'
 * @property {object} [result] - The result of the job, e.g. an OcrResponse
 * @property {object} [cancel_result] - If set, a cancel ends the job done with this result
 * @property {boolean} [fail] - Fail at the end
 */

/**
 * Answer the submits of an OCR route with stand-in jobs.
 * @param {Page} page
 * @param {string} urlGlob - The OCR route, e.g. '**\/api/v1/ocr'
 * @param {(body: any) => StandInJob} paramsFor - The job parameters for the request body
 * @returns {Promise<{requests: any[], jobIds: string[]}>} The bodies of the submits and the ids of the jobs
 */
export async function standInOcrJobs(page, urlGlob, paramsFor) {
  /** @type {any[]} */
  const requests = [];
  /** @type {string[]} */
  const jobIds = [];
  await page.route(urlGlob, async (/** @type {Route} */ route) => {
    const request = route.request();
    if (request.method() !== 'POST') return route.fallback();
    const body = request.postDataJSON();
    requests.push(body);
    const url = new URL(request.url());
    url.pathname = '/api/v1/jobs';
    const response = await route.fetch({
      url: url.toString(),
      method: 'POST',
      headers: request.headers(),
      postData: JSON.stringify({ type: 'test.progress', params: paramsFor(body) })
    });
    const job = await response.json();
    if (job.id) jobIds.push(job.id);
    await route.fulfill({ response, json: job });
  });
  return { requests, jobIds };
}

/**
 * The progress widget of a job.
 * @param {Page} page
 * @param {string} jobId
 */
export function jobWidget(page, jobId) {
  return page.locator(`.progress-widget[data-progress-id="job-${jobId}"]`);
}
