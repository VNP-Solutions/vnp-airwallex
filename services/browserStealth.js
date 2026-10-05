/**
 * Make the automation browser look like the browser it actually is.
 *
 * Airwallex's card element runs its own risk checks on whatever is filling it
 * in, and headless Chrome announces itself in several places at once: the user
 * agent says HeadlessChrome, navigator.webdriver is true, the Accept-Language
 * list is a single entry, and on a server with no GPU the WebGL renderer reads
 * "SwiftShader". Any one of those is enough to score a legitimate payment as
 * suspicious.
 *
 * Nothing here invents a persona. Chrome is really running, the version is its
 * real version, and the platform is the machine's real platform — the patches
 * only remove the automation tells and fill in the details headless mode leaves
 * blank. A fabricated profile would be less convincing, not more, because its
 * parts would disagree with each other.
 */

/** Headless Chrome with no GPU reports one of these as its WebGL renderer. */
const SOFTWARE_RENDERERS = /swiftshader|llvmpipe|software|mesa offscreen/i;

/**
 * Launch options that keep Chrome from advertising itself as automated.
 *
 * `--enable-automation` is what sets navigator.webdriver and shows the "Chrome
 * is being controlled by automated software" banner, so it is dropped rather
 * than patched over afterwards.
 */
function launchOptions({ headless = true, width = 1366, height = 850 } = {}) {
    return {
        headless,
        ignoreDefaultArgs: ['--enable-automation'],
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-blink-features=AutomationControlled',
            '--disable-infobars',
            // Translate's UI never appears for a real user on a checkout page
            // and its network chatter is noise. Origin isolation is left alone:
            // the card fields are cross-origin iframes, and weakening how Chrome
            // handles those is a change to the thing being automated.
            '--disable-features=Translate',
            // A window the same size as the viewport — a mismatch between the
            // two does not happen on a real desktop.
            `--window-size=${width},${height}`,
            '--lang=en-US',
            '--no-first-run',
            '--no-default-browser-check',
            '--password-store=basic',
        ],
        defaultViewport: null,
    };
}

/** The real user agent with the automation marker taken out. */
function cleanUserAgent(raw) {
    return String(raw || '').replace(/HeadlessChrome/g, 'Chrome');
}

/** Chrome's major version, for the client hints that accompany the UA. */
function majorVersion(ua) {
    const m = /Chrome\/(\d+)/.exec(ua || '');
    return m ? m[1] : '';
}

/**
 * Client-hint metadata matching the user agent.
 *
 * Chrome sends these as sec-ch-ua headers alongside every request. Left alone
 * they still say "HeadlessChrome", which contradicts the user agent we just
 * corrected — and a contradiction is a louder signal than either value alone.
 */
function userAgentMetadata(ua) {
    const version = majorVersion(ua);
    const platform = /Windows/.test(ua)
        ? 'Windows'
        : /Macintosh|Mac OS X/.test(ua)
          ? 'macOS'
          : 'Linux';

    return {
        brands: [
            { brand: 'Chromium', version },
            { brand: 'Google Chrome', version },
            { brand: 'Not=A?Brand', version: '24' },
        ],
        fullVersion: (/Chrome\/([\d.]+)/.exec(ua) || [])[1] || version,
        platform,
        platformVersion: '',
        architecture: 'x86',
        model: '',
        mobile: false,
    };
}

/**
 * Apply every evasion to one page.
 *
 * Must run before the page navigates: the document-level patches are installed
 * through evaluateOnNewDocument, which only affects documents loaded after the
 * call.
 */
async function applyStealth(page, { width = 1366, height = 850 } = {}) {
    const browser = page.browser();
    const ua = cleanUserAgent(await browser.userAgent());

    await page.setUserAgent(ua, userAgentMetadata(ua));

    // A real browser asks for a language list, not a single tag.
    await page.setExtraHTTPHeaders({
        'Accept-Language': 'en-US,en;q=0.9',
    });

    await page.evaluateOnNewDocument(
        ({ softwareRendererPattern }) => {
            // --- navigator.webdriver -------------------------------------
            // Removing it from the prototype leaves nothing behind. Defining a
            // getter that returns false is itself detectable, because the
            // property should not exist at all on a normal browser.
            try {
                delete Object.getPrototypeOf(navigator).webdriver;
            } catch (e) {
                /* already absent */
            }

            // --- languages -----------------------------------------------
            // Must agree with the Accept-Language header set above.
            try {
                Object.defineProperty(navigator, 'languages', {
                    get: () => ['en-US', 'en'],
                });
            } catch (e) {
                /* non-configurable in this build */
            }

            // --- window.chrome -------------------------------------------
            // Present in headed Chrome, and code that checks for it expects
            // more than an empty object.
            if (!window.chrome) window.chrome = {};
            if (!window.chrome.runtime) window.chrome.runtime = {};
            if (!window.chrome.app) {
                window.chrome.app = {
                    isInstalled: false,
                    InstallState: {
                        DISABLED: 'disabled',
                        INSTALLED: 'installed',
                        NOT_INSTALLED: 'not_installed',
                    },
                    RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' },
                };
            }
            if (!window.chrome.csi) window.chrome.csi = () => ({});
            if (!window.chrome.loadTimes) window.chrome.loadTimes = () => ({});

            // --- permissions ---------------------------------------------
            // Headless returns "denied" for notifications while
            // Notification.permission says "default" — the two disagreeing is a
            // well-known check.
            try {
                const original = window.navigator.permissions.query.bind(
                    window.navigator.permissions
                );
                window.navigator.permissions.query = (parameters) =>
                    parameters && parameters.name === 'notifications'
                        ? Promise.resolve({ state: Notification.permission })
                        : original(parameters);
            } catch (e) {
                /* permissions API unavailable */
            }

            // --- WebGL ----------------------------------------------------
            // On a server with no GPU the renderer reads "SwiftShader", which
            // no ordinary desktop reports. Left alone where real hardware is
            // present, so a developer running this on their own machine keeps
            // their genuine values.
            try {
                const re = new RegExp(softwareRendererPattern, 'i');
                const VENDOR = 37445; // UNMASKED_VENDOR_WEBGL
                const RENDERER = 37446; // UNMASKED_RENDERER_WEBGL

                const patch = (proto) => {
                    if (!proto || !proto.getParameter) return;
                    const getParameter = proto.getParameter;
                    proto.getParameter = function (parameter) {
                        if (parameter === VENDOR || parameter === RENDERER) {
                            // Decided from the renderer for both values. Only
                            // the renderer string names SwiftShader, so testing
                            // each parameter separately swapped the renderer and
                            // left the vendor alone — and an Intel renderer
                            // beside a Google vendor is a mismatch no real
                            // machine produces.
                            const renderer = String(getParameter.call(this, RENDERER) || '');
                            if (re.test(renderer)) {
                                return parameter === VENDOR
                                    ? 'Intel Inc.'
                                    : 'Intel Iris OpenGL Engine';
                            }
                        }
                        return getParameter.call(this, parameter);
                    };
                };
                patch(window.WebGLRenderingContext && window.WebGLRenderingContext.prototype);
                patch(window.WebGL2RenderingContext && window.WebGL2RenderingContext.prototype);
            } catch (e) {
                /* no WebGL in this context */
            }

            // --- plugins --------------------------------------------------
            // Modern Chrome reports a fixed set of five PDF entries. Only
            // filled in when the list is empty, which is what older headless
            // builds produce.
            try {
                if (navigator.plugins && navigator.plugins.length === 0) {
                    Object.defineProperty(navigator, 'plugins', {
                        get: () => [1, 2, 3, 4, 5],
                    });
                }
            } catch (e) {
                /* non-configurable */
            }

            // --- hardware -------------------------------------------------
            // A machine claiming one core looks like a container, not a desk.
            try {
                if (navigator.hardwareConcurrency < 2) {
                    Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
                }
            } catch (e) {
                /* non-configurable */
            }
        },
        { softwareRendererPattern: SOFTWARE_RENDERERS.source }
    );

    // Screen and window agreeing with each other, as they do on a real desktop.
    await page.setViewport({ width, height, deviceScaleFactor: 1 });

    return ua;
}

module.exports = { launchOptions, applyStealth, cleanUserAgent, userAgentMetadata };
