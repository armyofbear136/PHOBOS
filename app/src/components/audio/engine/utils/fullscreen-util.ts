/**
 * fullscreen-util.ts — Phase 2a port (bowser-free).
 *
 * The original Efflux file imported `bowser` solely to detect iOS, which
 * doesn't support the Fullscreen API. Bowser is a 50KB browser detection
 * library; for one boolean check that's wasteful. We use a tiny inline UA
 * test instead.
 *
 * If bowser becomes needed elsewhere later, install it and revert this
 * file to the upstream version.
 */

const d = window.document;
let fsToggle: Element;
let fsCallback: () => void;

/**
 * Detect iOS via user-agent. iOS Safari (and any browser on iOS, since
 * Apple forces all browsers to use WebKit there) doesn't support the
 * Fullscreen API. iPad on iOS 13+ reports as "Macintosh" with touch — we
 * include that case too.
 */
function isIOS(): boolean {
  const ua = window.navigator.userAgent;
  if (/iPad|iPhone|iPod/.test(ua)) return true;
  // iPad on iOS 13+ pretends to be macOS — disambiguate via touch points.
  if (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) return true;
  return false;
}

export const isSupported = (): boolean => !isIOS();

export const setToggleButton = ( element: Element, callback: () => void ): void => {
    fsToggle = element;
    fsToggle.addEventListener( "click", toggleFullscreen );

    fsCallback = callback;

    [
        "webkitfullscreenchange", "mozfullscreenchange", "fullscreenchange", "MSFullscreenChange"
    ]
    .forEach( event => d.addEventListener( event, handleFullscreenChange, false ));
};

/* internal methods */

function toggleFullscreen(): void {
    let requestMethod, element;
    // @ts-expect-error vendor prefixed fallbacks not declared in spec
    if ( d.fullscreenElement || d.webkitFullscreenElement ) {
        // @ts-expect-error vendor prefixed fallbacks not declared in spec
        requestMethod = d.exitFullscreen || d.webkitExitFullscreen || d.mozCancelFullScreen || d.msExitFullscreen;
        element = d;
    } else {
        // @ts-expect-error vendor prefixed fallbacks not declared in spec
        requestMethod = d.body.requestFullScreen || d.body.webkitRequestFullScreen || d.body.mozRequestFullScreen || d.body.msRequestFullscreen;
        element = d.body;
    }
    if ( requestMethod ) {
        requestMethod.call( element );
    }
}

function handleFullscreenChange(): void {
    // @ts-expect-error vendor prefixed fallbacks not declared in spec
    fsCallback( document.webkitIsFullScreen || document.mozFullScreen || document.msFullscreenElement === true );
}
