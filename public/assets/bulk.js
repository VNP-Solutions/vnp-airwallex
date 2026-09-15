/**
 * Shared helpers for the CSV bulk flows (hotels + payments).
 *
 * Template downloads sit behind requireAuth, so a plain <a href> would get a
 * 401 — every download is fetched with the bearer token and saved from a blob.
 */
window.BulkUpload = (() => {
    function getToken() {
        return localStorage.getItem('auth_token') || sessionStorage.getItem('auth_token');
    }

    function escapeHtml(value) {
        return String(value == null ? '' : value).replace(
            /[&<>"']/g,
            (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
        );
    }

    /** Fetch a protected CSV endpoint and save it as a file. */
    async function download(url, fallbackName = 'download.csv') {
        const res = await fetch(url, { headers: { Authorization: `Bearer ${getToken()}` } });
        if (res.status === 401) {
            window.location.replace('/login');
            return;
        }
        if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            throw new Error(data.error || 'Download failed');
        }

        // Prefer the filename the server chose.
        let filename = fallbackName;
        const disposition = res.headers.get('Content-Disposition') || '';
        const match = disposition.match(/filename="?([^"]+)"?/);
        if (match) filename = match[1];

        const blob = await res.blob();
        const objectUrl = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = objectUrl;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        link.remove();
        // Give the browser a moment to start the download before revoking.
        setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
    }

    /**
     * Wire a dropzone + file input into a single "chosen file" state.
     * Calls onChange(file|null) whenever the selection changes.
     */
    function attachDropzone({ dropzone, fileInput, textEl, hintEl, onChange }) {
        let current = null;

        function accept(file) {
            if (!file) return;
            // Browsers report spreadsheet MIME types inconsistently across
            // platforms, so trust the extension and let the server decide by
            // magic bytes.
            const looksTabular = /\.(csv|xlsx)$/i.test(file.name);
            if (!looksTabular) {
                textEl.textContent =
                    /\.xls$/i.test(file.name)
                        ? 'Legacy .xls — re-save as .xlsx or CSV'
                        : 'That is not a CSV or Excel file';
                dropzone.classList.add('is-error');
                current = null;
                onChange(null);
                return;
            }
            current = file;
            dropzone.classList.remove('is-error');
            dropzone.classList.add('has-file');
            textEl.textContent = file.name;
            if (hintEl) hintEl.textContent = `${(file.size / 1024).toFixed(1)} KB — ready to upload`;
            onChange(file);
        }

        fileInput.addEventListener('change', () => accept(fileInput.files[0]));

        ['dragenter', 'dragover'].forEach((type) => {
            dropzone.addEventListener(type, (event) => {
                event.preventDefault();
                dropzone.classList.add('is-dragging');
            });
        });
        ['dragleave', 'drop'].forEach((type) => {
            dropzone.addEventListener(type, (event) => {
                event.preventDefault();
                dropzone.classList.remove('is-dragging');
            });
        });
        dropzone.addEventListener('drop', (event) => {
            const file = event.dataTransfer && event.dataTransfer.files[0];
            accept(file);
        });

        return {
            get file() {
                return current;
            },
            reset(defaultText, defaultHint) {
                current = null;
                fileInput.value = '';
                dropzone.classList.remove('has-file', 'is-error', 'is-dragging');
                textEl.textContent = defaultText;
                if (hintEl) hintEl.textContent = defaultHint;
                onChange(null);
            },
        };
    }

    /**
     * Content-Type to send for a given file. Files are uploaded as the File
     * object itself — .xlsx must go up as raw bytes, since decoding a zip to
     * text corrupts it — and the server re-sniffs the format regardless.
     */
    function contentTypeFor(file) {
        return /\.xlsx$/i.test(file.name)
            ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
            : 'text/csv';
    }

    /** Render a validation/apply result: either the row errors or a summary. */
    function renderResult(el, result, { successLabel = 'Applied' } = {}) {
        if (!result) {
            el.hidden = true;
            return;
        }

        const errors = result.errors || [];
        if (errors.length) {
            const shown = errors.slice(0, 50);
            el.className = 'bulk-result is-error';
            el.innerHTML = `
                <div class="bulk-result-head">
                    <strong>${errors.length} row${errors.length === 1 ? '' : 's'} need${
                        errors.length === 1 ? 's' : ''
                    } fixing</strong>
                    <span>Nothing was saved — correct the file and upload again.</span>
                </div>
                <ul class="bulk-error-list">
                    ${shown
                        .map(
                            (e) => `<li><span class="bulk-line">Line ${e.line}</span>${escapeHtml(
                                e.error
                            )}</li>`
                        )
                        .join('')}
                </ul>
                ${
                    errors.length > shown.length
                        ? `<p class="bulk-more">…and ${errors.length - shown.length} more</p>`
                        : ''
                }`;
            el.hidden = false;
            return;
        }

        el.className = 'bulk-result is-success';
        const bits = [];
        if (result.created != null) bits.push(`${result.created} created`);
        if (result.updated != null) bits.push(`${result.updated} updated`);
        if (result.ready != null) bits.push(`${result.ready} ready`);
        el.innerHTML = `
            <div class="bulk-result-head">
                <strong>${successLabel}</strong>
                <span>${escapeHtml(bits.join(' · ') || `${result.total} rows`)}</span>
            </div>`;
        el.hidden = false;
    }

    return { download, attachDropzone, contentTypeFor, renderResult, escapeHtml, getToken };
})();
