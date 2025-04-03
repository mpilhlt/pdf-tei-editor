const api_base_url = 'http://127.0.0.1:3001/';

export async function remote_xmllint(xmlString) {
  /**
   * Lints a TEI XML string against the Flask API endpoint.
   *
   * @param {string} xmlString - The TEI XML string to validate.
   * @returns {Promise<Array<string>>} - A promise that resolves to an array of error messages,
   *                                    or rejects with an error message if the request fails.
   *                                    Returns an empty array if no errors are found.
   */
  const apiUrl = `${api_base_url}tei-lint`; // Adjust if your Flask app is running on a different port/address

  try {
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ xml_string: xmlString }),
    });

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
    console.error('Error linting TEI XML:', error);
    throw error; 
  }
}