<?php
/**
 * Plugin Name: SML GA4 Creator — content resolver extension
 * Description: Extends sml-ga4-creator's sml_ga4_creator_context filter for
 *              content types the base plugin can't see on its own (watch
 *              pages, the live page, group pages). Kept separate from
 *              sml-ga4-creator.php so a future update of that plugin never
 *              discards this mapping — per CODEX-GA4-HANDOFF.md step 3.
 *
 * Every pattern below was checked against the real plugin source (this
 * machine has a local mirror of sml-video-upload-studio) or the real
 * live-watch.js routing logic — not guessed. Group pages are deliberately
 * NOT covered here: no local source for "Group Shell v11" to verify
 * ownership against, and the base plugin's own rule is to return nothing
 * rather than guess. That's the one piece still open — see the TODO below.
 */

if ( ! function_exists( 'sml_ga4_ctx_video_owner' ) ) {
	/**
	 * /watch/{id}/ — uploaded videos.
	 *
	 * Videos are NOT WordPress posts. sml-video-upload-studio stores them in
	 * a flat option-backed library keyed by video id (ids look like
	 * "88kbaonkfnj1", not numeric post IDs — confirmed against the real
	 * plugin source, function sml_video_upload_studio_get_video() in
	 * sml-video-upload-studio.php). The handoff doc's own example code
	 * assumed a numeric post ID and would have silently attributed zero
	 * watch-page traffic; this uses the real accessor instead.
	 */
	function sml_ga4_ctx_video_owner( $ctx, $path ) {
		if ( '' !== $ctx['handle'] ) { return $ctx; } // already resolved
		if ( ! preg_match( '#^watch/([a-z0-9_-]+)#i', $path, $m ) ) { return $ctx; }
		if ( ! function_exists( 'sml_video_upload_studio_get_video' ) ) { return $ctx; }

		$video = sml_video_upload_studio_get_video( $m[1] );
		if ( ! is_array( $video ) || empty( $video['author_id'] ) ) { return $ctx; }

		$u = get_userdata( (int) $video['author_id'] );
		if ( $u ) {
			$ctx['handle'] = $u->user_nicename;
			$ctx['kind']   = 'video';
		}
		return $ctx;
	}
	add_filter( 'sml_ga4_creator_context', 'sml_ga4_ctx_video_owner', 10, 2 );
}

if ( ! function_exists( 'sml_ga4_ctx_live_owner' ) ) {
	/**
	 * /live/ — the live watch page. Confirmed against the real routing in
	 * live-watch.js: `var HANDLE = (qs('s') || 'grandmasterobi')...` — the
	 * page is keyed by a ?s= query param and falls back to a fixed default
	 * handle when absent. This mirrors that exactly, so it's not a guess —
	 * it's the same resolution the live page itself already performs.
	 */
	function sml_ga4_ctx_live_owner( $ctx, $path ) {
		if ( '' !== $ctx['handle'] ) { return $ctx; }
		if ( 'live' !== $path ) { return $ctx; }

		$handle = isset( $_GET['s'] ) ? sanitize_title( wp_unslash( $_GET['s'] ) ) : 'grandmasterobi';
		if ( $handle ) {
			$ctx['handle'] = $handle;
			$ctx['kind']   = 'live';
		}
		return $ctx;
	}
	add_filter( 'sml_ga4_creator_context', 'sml_ga4_ctx_live_owner', 10, 2 );
}

/**
 * TODO (needs live verification, not guessed):
 * - Group pages (StockMarketLoop Group Shell v11) — no local source to
 *   confirm single-owner vs multi-owner semantics. Per the base plugin's own
 *   rule, do not add a pattern here until ownership is confirmed against the
 *   real plugin; a group may have no single creator, in which case this
 *   should keep returning nothing.
 * - SML Group Live Video Rooms / StockMarketLoop Ticker Voice Rooms — same:
 *   no local source, needs a real URL pattern + owner lookup confirmed on
 *   the live site before adding a filter here.
 */
