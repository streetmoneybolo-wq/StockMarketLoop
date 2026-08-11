/* SML LOOP-KICK bridge: site-wide floating widget controller. */
( function () {
	'use strict';

	var launcherSelector = [
		'[data-sml-loop-launcher]',
		'#wp-admin-bar-sml-loop-inbox',
		'.sml-loop-inbox-link',
		'a[href*="stockmarketloop-loop-kick.onrender.com/loop-kick/"]'
	].join( ',' );

	function surface() {
		var popup = document.getElementById( 'sml-loop-popup' );
		var frame = document.getElementById( 'sml-loop-popup-frame' );
		return popup && frame ? { popup: popup, frame: frame } : null;
	}

	function prepare() {
		var launcher = document.querySelector( '[data-sml-loop-launcher]' );
		var label = launcher && launcher.querySelector( '.sml-loop-launcher-label' );
		if ( label ) label.textContent = 'LOOP-KICK';
		if ( launcher ) launcher.setAttribute( 'aria-label', 'Open LOOP-KICK' );

		var widget = surface();
		if ( widget ) {
			widget.popup.setAttribute( 'aria-label', 'LOOP-KICK' );
			widget.frame.title = 'LOOP-KICK';
			widget.frame.setAttribute( 'allow', 'microphone; camera; autoplay' );
		}

		var close = document.querySelector( '[data-sml-loop-popup-close]' );
		if ( close ) close.setAttribute( 'aria-label', 'Close LOOP-KICK' );
	}

	function openWidget() {
		var widget = surface();
		if ( ! widget ) return false;
		if ( ! widget.frame.getAttribute( 'src' ) && widget.frame.dataset.src ) {
			widget.frame.setAttribute( 'src', widget.frame.dataset.src );
		}
		widget.popup.hidden = false;
		document.body.classList.add( 'sml-loop-open' );
		widget.popup.focus();
		return true;
	}

	// Capture the click before legacy handlers can follow the link. This is a
	// one-time listener; the bridge deliberately does not watch or rewrite DOM.
	document.addEventListener( 'click', function ( event ) {
		var target = event.target instanceof Element && event.target.closest( launcherSelector );
		if ( ! target || ! openWidget() ) return;
		event.preventDefault();
		event.stopImmediatePropagation();
	}, true );

	if ( document.readyState === 'loading' ) {
		document.addEventListener( 'DOMContentLoaded', prepare, { once: true } );
	} else {
		prepare();
	}
}() );
