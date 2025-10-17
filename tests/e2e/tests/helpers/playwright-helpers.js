
/**
 * @import {Page} from "@playwright/test"
 */

/**
 * @param {Page} page
 * @param {() => Promise<any>} fn 
 * @returns {void}
 */
async function haltOnException(page, fn) {
  try {
    return await fn();
  } catch (error) {
    console.error(error)
    page.pause()
    throw error;
  }
}