/**
 * Active Sessions plugin view script.
 *
 * Initializes the DataTable with AJAX data source and handles session
 * removal actions via the plugin sandbox API.
 */

// Session ID is passed as a query param by the application when opening the iframe
const sessionId = new URLSearchParams(window.location.search).get('session_id') || '';

$(function () {
    const table = $('#sessionsTable').DataTable({
        ajax: {
            url: '/api/plugins/active-sessions/data',
            type: 'GET',
            headers: { 'X-Session-ID': sessionId },
            dataSrc: 'data',
            error: function (xhr, error, thrown) {
                console.error('DataTables AJAX error:', error, thrown);
            },
        },
        columns: [
            { title: 'Session ID' },
            { title: 'Age', render: (data, type) => type === 'sort' ? data.sort : data.display },
            { title: 'Last Access', render: (data, type) => type === 'sort' ? data.sort : data.display },
            { title: 'Owner' },
            { title: 'Action', orderable: false },
        ],
        order: [[1, 'asc']],
        pageLength: 25,
        language: {
            search: 'Search:',
            lengthMenu: 'Show _MENU_ entries',
            info: 'Showing _START_ to _END_ of _TOTAL_ entries',
        },
    });

    // Reload table data every 5 seconds without resetting pagination or sort
    setInterval(() => table.ajax.reload(null, false), 5000);

    // Expose action handlers as globals so DataTable-rendered onclick attributes can call them
    window.removeSession = async function (targetId) {
        if (!confirm('Remove this session?')) return;
        const message = $('#end-all-message').val().trim() || DEFAULT_MESSAGE;
        try {
            await sandbox.callPluginApi(
                '/api/plugins/active-sessions/remove',
                'POST',
                { target_session_id: targetId, message }
            );
            table.ajax.reload(null, false);
        } catch (err) {
            alert('Error: ' + err.message);
        }
    };

    const DEFAULT_MESSAGE = 'Your session was ended by an administrator.';

    window.endAllSessions = async function () {
        if (!confirm('End all other sessions? This will log out all users except you.')) return;
        const message = $('#end-all-message').val().trim() || DEFAULT_MESSAGE;
        try {
            await sandbox.callPluginApi('/api/plugins/active-sessions/remove-all', 'POST', { message });
            table.ajax.reload(null, false);
        } catch (err) {
            alert('Error: ' + err.message);
        }
    };

    $('#footer-actions').html(
        '<button id="end-all-btn">End All Sessions</button>' +
        '<label for="end-all-message" style="margin-left:12px;font-size:0.9em;">Message to users:</label>' +
        '<input id="end-all-message" type="text" value="' + DEFAULT_MESSAGE + '"' +
        ' style="margin-left:6px;width:380px;padding:5px 8px;border:1px solid #ccc;border-radius:3px;font-size:0.9em;"' +
        ' placeholder="Message shown to logged-out users">'
    );
    $('#end-all-btn').on('click', window.endAllSessions);
});
