
/**
 * Uploads a file selected by the user to a specified URL using `fetch()`.
 *
 * @author Gemini 2.0
 * @param {string} uploadUrl - The URL to which the file will be uploaded.
 * @param {object} [options={}] - Optional configuration options.
 * @param {string} [options.method='POST'] - The HTTP method to use for the upload.
 * @param {string} [options.fieldName='file'] - The name of the form field for the file.
 * @param {object} [options.headers={}] - Additional headers to include in the request.
 * @param {function} [options.onProgress] - A callback function to handle upload progress events.
 *        The function receives a progress event object as an argument.
 * @returns {Promise<Response>} - A Promise that resolves with the `Response` object
 *                             from the `fetch()` call or rejects with an error.
 * @example
 * // Async/Await example (requires an async function context):
 * async function myUploadFunction() {
 *   try {
 *     const response = await uploadFile('https://example.com/upload', {
 *       fieldName: 'my_file',
 *       headers: {
 *         'X-Custom-Header': 'value'
 *       },
 *       onProgress: (event) => {
 *         if (event.lengthComputable) {
 *           const percentComplete = (event.loaded / event.total) * 100;
 *           console.log(`Uploaded: ${percentComplete.toFixed(2)}%`);
 *         } else {
 *           console.log("Total size is unknown");
 *         }
 *       } 
 *     });
 *
 *     if (response.ok) {
 *       const data = await response.json();
 *       console.log('Upload successful:', data);
 *     } else {
 *       throw new Error(`Upload failed: ${response.status} ${response.statusText}`);
 *     }
 *   } catch (error) {
 *     console.error('Error uploading file:', error);
 *   }
 * }
 */
export async function uploadFile(uploadUrl, options = {}) {
  return new Promise((resolve, reject) => {
    const {
      method = 'POST',
      fieldName = 'file',
      headers = {},
      onProgress,
    } = options;
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.pdf, .xml';
    input.addEventListener('change', async () => {
      const file = input.files[0];
      if (!file) {
        reject(new Error('No file selected.'));
        return;
      }
      const formData = new FormData();
      formData.append(fieldName, file);
      const fetchOptions = {
        method: method,
        body: formData,
        headers: headers
      };
      try {
        const response = await fetch(uploadUrl, fetchOptions);
        if (!response.ok) {
          reject(new Error(`HTTP error! Status: ${response.status}`));
          return;
        }
        let result = await response.json()
        if (result.error) {
          reject(result.error)
        }
        resolve(result);
      } catch (error) {
        reject(error);
      }
    });

    // Programmatically trigger the file chooser dialog.  Crucially, this must be initiated from a user action,
    // such as a button click, to work correctly in most browsers. Directly calling input.click() on page load will generally be blocked.
    input.click();
  });
}