const api_base_url = '/api';

/**
 * A generic function to make API requests.
 *
 * @param {string} endpoint - The API endpoint to call.
 * @param {string} method - The HTTP method to use (e.g., 'GET', 'POST').
 * @param {object} body - The request body (optional).  Will be stringified to JSON.
 * @returns {Promise<any>} - A promise that resolves to the response data,
 *                           or rejects with an error message if the request fails.
 */
async function callApi(endpoint, method, body = null) {
  const url = `${api_base_url}${endpoint}`;
  const options = {
    method,
    headers: {
      'Content-Type': 'application/json',
    },
  };

  if (body) {
    options.body = JSON.stringify(body);
  }

  try {
    const response = await fetch(url, options);

    if (!response.ok) {
      let errorMessage = `HTTP error! status: ${response.status}`;
      try {
        const errorData = await response.json();
        if (errorData && errorData.error) {
          errorMessage += ` - ${errorData.error}`;
        }
      } catch (jsonError) {
        console.error("Failed to parse error response as JSON:", jsonError);
      }
      throw new Error(errorMessage);
    }

    return await response.json();
  } catch (error) {
    console.error(`Error calling API endpoint ${endpoint}:`, error);
    throw error;
  }
}

/**
 * Lints a TEI XML string against the Flask API endpoint.
 *
 * @param {string} xmlString - The TEI XML string to validate.
 * @returns {Promise<Array<string>>} - A promise that resolves to an array of error messages,
 */
export async function remote_xmllint(xmlString) {
  return callApi('/validate', 'POST', { xml_string: xmlString });
}