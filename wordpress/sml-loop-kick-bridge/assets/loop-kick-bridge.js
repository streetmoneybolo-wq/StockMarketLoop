/* SML LOOP-KICK bridge: site-wide floating widget controller. */
( function () {
	'use strict';
	var prepareQueued = false;

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

	function resetSurfaceMask( widget ) {
		widget.frame.style.removeProperty( '-webkit-mask-image' );
		widget.frame.style.removeProperty( 'mask-image' );
		delete widget.frame.dataset.smlLoopKickSurface;
	}

	function expectedFrameOrigin( frame ) {
		try {
			return new URL( frame.getAttribute( 'src' ) || frame.dataset.src || '', document.baseURI ).origin;
		} catch ( error ) {
			return '';
		}
	}

	function finiteNumber( value ) {
		var number = Number( value );
		return isFinite( number ) ? number : null;
	}

	function applySurfaceMask( widget, data ) {
		var viewport = data && data.viewport;
		var width = viewport && finiteNumber( viewport.width );
		var height = viewport && finiteNumber( viewport.height );
		var surfaces = data && Array.isArray( data.surfaces ) ? data.surfaces : [];
		if ( ! width || ! height || width < 1 || height < 1 || ! surfaces.length ) return;

		var rectangles = [];
		for ( var index = 0; index < surfaces.length && index < 3; index += 1 ) {
			var source = surfaces[ index ];
			var x = finiteNumber( source.x );
			var y = finiteNumber( source.y );
			var rectWidth = finiteNumber( source.width );
			var rectHeight = finiteNumber( source.height );
			var radius = finiteNumber( source.radius ) || 0;
			if ( x === null || y === null || ! rectWidth || ! rectHeight ) continue;

			var padding = 5;
			x = Math.max( 0, x - padding );
			y = Math.max( 0, y - padding );
			rectWidth = Math.min( width - x, rectWidth + ( padding * 2 ) );
			rectHeight = Math.min( height - y, rectHeight + ( padding * 2 ) );
			if ( rectWidth < 1 || rectHeight < 1 ) continue;
			radius = Math.max( 0, Math.min( radius + padding, rectWidth / 2, rectHeight / 2 ) );

			rectangles.push(
				'<rect x="' + x.toFixed( 2 )
				+ '" y="' + y.toFixed( 2 )
				+ '" width="' + rectWidth.toFixed( 2 )
				+ '" height="' + rectHeight.toFixed( 2 )
				+ '" rx="' + radius.toFixed( 2 )
				+ '" fill="white"/>'
			);
		}
		if ( ! rectangles.length ) return;

		var svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 '
			+ width.toFixed( 2 ) + ' ' + height.toFixed( 2 )
			+ '" preserveAspectRatio="none">' + rectangles.join( '' ) + '</svg>';
		var mask = 'url("data:image/svg+xml;charset=utf-8,' + encodeURIComponent( svg ) + '")';
		widget.frame.style.setProperty( '-webkit-mask-image', mask, 'important' );
		widget.frame.style.setProperty( 'mask-image', mask, 'important' );
		widget.frame.dataset.smlLoopKickSurface = String( data.surface || 'expanded' );
	}

	function setReady( widget ) {
		widget.frame.dataset.smlLoopKickLoaded = '1';
		window.requestAnimationFrame( function () {
			window.requestAnimationFrame( function () {
				if ( ! widget.popup.isConnected || ! widget.frame.isConnected ) return;
				widget.popup.classList.remove( 'sml-loop-kick-loading' );
				widget.popup.classList.add( 'sml-loop-kick-ready' );
			} );
		} );
	}

	function setLoading( widget ) {
		resetSurfaceMask( widget );
		widget.popup.classList.remove( 'sml-loop-kick-ready' );
		widget.popup.classList.add( 'sml-loop-kick-loading' );
	}

	function prepareWidget( widget ) {
		var firstBinding = widget.frame.dataset.smlLoopKickBridgeBound !== '1';
		widget.popup.setAttribute( 'aria-label', 'LOOP-KICK' );
		widget.popup.classList.add( 'sml-loop-kick-enhanced' );
		widget.frame.title = 'LOOP-KICK';
		widget.frame.setAttribute( 'allow', 'microphone; camera; autoplay' );
		widget.frame.setAttribute( 'allowtransparency', 'true' );
		// Chromium can paint a white browsing-context canvas even when the
		// embedded document reports a transparent root. The device mask hides
		// that canvas; this dark fallback protects first paint and app updates.
		widget.frame.style.setProperty( 'background', '#020806', 'important' );
		widget.frame.style.setProperty( 'background-color', '#020806', 'important' );
		widget.frame.style.setProperty( 'color-scheme', 'dark', 'important' );

		if ( firstBinding ) {
			widget.frame.dataset.smlLoopKickBridgeBound = '1';
			widget.frame.addEventListener( 'load', function () {
				var src = widget.frame.getAttribute( 'src' );
				if ( ! src || src === 'about:blank' ) return;
				setReady( widget );
			} );

			// The legacy popup can assign src before this bridge is loaded. Take
			// ownership once so the ready listener cannot miss the first paint.
			var existingSrc = widget.frame.getAttribute( 'src' );
			if ( existingSrc && existingSrc !== 'about:blank' ) {
				if ( ! widget.frame.dataset.src ) {
					widget.frame.dataset.src = existingSrc;
				}
				widget.frame.removeAttribute( 'src' );
			}
		}

		if ( widget.frame.dataset.smlLoopKickLoaded === '1' ) {
			setReady( widget );
		}
	}

	function loadWidgetFrame( widget ) {
		if ( ! widget.frame.getAttribute( 'src' ) && widget.frame.dataset.src ) {
			setLoading( widget );
			widget.frame.setAttribute( 'src', widget.frame.dataset.src );
		} else if ( widget.frame.dataset.smlLoopKickLoaded === '1' ) {
			setReady( widget );
		} else {
			setLoading( widget );
		}
	}

	function prepare() {
		var launcher = document.querySelector( '[data-sml-loop-launcher]' );
		var label = launcher && launcher.querySelector( '.sml-loop-launcher-label' );
		if ( label ) label.textContent = 'LOOP-KICK';
		if ( launcher ) launcher.setAttribute( 'aria-label', 'Open LOOP-KICK' );

		var widget = surface();
		if ( widget ) {
			prepareWidget( widget );
			if ( ! widget.popup.hidden ) {
				loadWidgetFrame( widget );
			}
		}

		var close = document.querySelector( '[data-sml-loop-popup-close]' );
		if ( close ) close.setAttribute( 'aria-label', 'Close LOOP-KICK' );
	}

	function openWidget() {
		var widget = surface();
		if ( ! widget ) return false;
		prepareWidget( widget );
		loadWidgetFrame( widget );
		widget.popup.hidden = false;
		document.body.classList.add( 'sml-loop-open' );
		widget.popup.focus();
		return true;
	}

	function containsBridgeSurface( node ) {
		if ( ! ( node instanceof Element ) ) return false;
		if ( node.id === 'sml-loop-popup' || node.id === 'sml-loop-popup-frame' ) return true;
		if ( node.matches( launcherSelector ) ) return true;
		return Boolean( node.querySelector( '#sml-loop-popup,#sml-loop-popup-frame,' + launcherSelector ) );
	}

	function queuePrepare() {
		if ( prepareQueued ) return;
		prepareQueued = true;
		window.requestAnimationFrame( function () {
			prepareQueued = false;
			prepare();
		} );
	}

	function observeSurface() {
		if ( ! document.body || typeof MutationObserver === 'undefined' ) return;
		var observer = new MutationObserver( function ( mutations ) {
			for ( var i = 0; i < mutations.length; i += 1 ) {
				for ( var j = 0; j < mutations[ i ].addedNodes.length; j += 1 ) {
					if ( containsBridgeSurface( mutations[ i ].addedNodes[ j ] ) ) {
						queuePrepare();
						return;
					}
				}
			}
		} );
		observer.observe( document.body, { childList: true, subtree: true } );
	}

	// Capture the click before legacy handlers can follow the link. The observer
	// only repairs a launcher or popup that another plugin replaces.
	document.addEventListener( 'click', function ( event ) {
		var target = event.target instanceof Element && event.target.closest( launcherSelector );
		if ( ! target || ! openWidget() ) return;
		event.preventDefault();
		event.stopImmediatePropagation();
	}, true );

	window.addEventListener( 'message', function ( event ) {
		var widget = surface();
		var data = event.data;
		if ( ! widget || event.source !== widget.frame.contentWindow ) return;
		if ( ! data || data.type !== 'sml-loop-kick:surface' || data.version !== 1 ) return;
		var expectedOrigin = expectedFrameOrigin( widget.frame );
		if ( ! expectedOrigin || event.origin !== expectedOrigin ) return;
		applySurfaceMask( widget, data );
	} );

	if ( document.readyState === 'loading' ) {
		document.addEventListener( 'DOMContentLoaded', function () {
			prepare();
			observeSurface();
		}, { once: true } );
	} else {
		prepare();
		observeSurface();
	}
}() );
