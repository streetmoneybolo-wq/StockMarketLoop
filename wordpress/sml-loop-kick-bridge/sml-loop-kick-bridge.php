<?php
/**
 * Plugin Name: SML LOOP-KICK Bridge
 * Description: Replaces the Loop Messenger launcher with the hosted LOOP-KICK device while preserving the existing messenger as a rollback path.
 * Version: 1.0.0
 * Author: Stock Market Loop
 */

declare( strict_types = 1 );

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

final class SML_Loop_Kick_Bridge {
	private const APP_URL = 'https://stockmarketloop-loop-kick.onrender.com/';
	private const TOKEN_TTL = 12 * HOUR_IN_SECONDS;

	private static string $token = '';

	public static function boot(): void {
		add_filter( 'option_sml_loop_messages_url', array( __CLASS__, 'launcher_url' ), 99 );
		add_action( 'admin_bar_menu', array( __CLASS__, 'admin_bar' ), 999 );
		add_action( 'wp_footer', array( __CLASS__, 'finish_launcher' ), 100 );
		add_action( 'rest_api_init', array( __CLASS__, 'routes' ) );
	}

	private static function token(): string {
		if ( self::$token || ! is_user_logged_in() ) {
			return self::$token;
		}

		self::$token = bin2hex( random_bytes( 32 ) );
		set_transient(
			'sml_lk_session_' . hash( 'sha256', self::$token ),
			array( 'userId' => 'wp-' . get_current_user_id() ),
			self::TOKEN_TTL
		);
		return self::$token;
	}

	public static function launcher_url( $stored ): string {
		if ( is_admin() || ! is_user_logged_in() ) {
			return is_string( $stored ) ? $stored : '';
		}

		$url = add_query_arg(
			array(
				'embed'    => '1',
				'peer'     => 'loop',
				'peerName' => 'Loop',
			),
			self::APP_URL
		);
		return $url . '#session=' . rawurlencode( self::token() );
	}

	public static function routes(): void {
		register_rest_route(
			'sml-loop-kick/v1',
			'/session',
			array(
				'methods'             => WP_REST_Server::READABLE,
				'callback'            => array( __CLASS__, 'verify_session' ),
				'permission_callback' => '__return_true',
				'args'                => array(
					'token' => array( 'required' => true, 'type' => 'string' ),
				),
			)
		);
	}

	public static function verify_session( WP_REST_Request $request ) {
		$token = (string) $request->get_param( 'token' );
		if ( ! preg_match( '/^[a-f0-9]{64}$/', $token ) ) {
			return new WP_Error( 'sml_lk_invalid_session', 'Invalid session.', array( 'status' => 401 ) );
		}
		$identity = get_transient( 'sml_lk_session_' . hash( 'sha256', $token ) );
		if ( ! is_array( $identity ) || empty( $identity['userId'] ) ) {
			return new WP_Error( 'sml_lk_expired_session', 'Session expired.', array( 'status' => 401 ) );
		}
		$response = rest_ensure_response( array( 'userId' => sanitize_text_field( (string) $identity['userId'] ) ) );
		$response->header( 'Cache-Control', 'no-store, private' );
		return $response;
	}

	public static function admin_bar( $bar ): void {
		if ( ! is_user_logged_in() || ! is_object( $bar ) || ! class_exists( 'SML_Loop_Entry' ) ) {
			return;
		}
		$unread = method_exists( 'SML_Loop_Entry', 'unread' ) ? SML_Loop_Entry::unread( get_current_user_id() ) : 0;
		$title  = 'LOOP-KICK';
		if ( $unread > 0 ) {
			$title .= ' <span class="sml-loop-bar-badge">' . esc_html( $unread > 99 ? '99+' : (string) $unread ) . '</span>';
		}
		$bar->add_node(
			array(
				'id'    => 'sml-loop-inbox',
				'title' => $title,
				'href'  => self::launcher_url( '' ),
				'meta'  => array(
					'title'   => 'Open LOOP-KICK',
					'onclick' => "event.preventDefault();var p=document.getElementById('sml-loop-popup');if(p){var f=document.getElementById('sml-loop-popup-frame');if(f&&!f.getAttribute('src')&&f.dataset.src)f.setAttribute('src',f.dataset.src);p.hidden=false;document.body.classList.add('sml-loop-open');p.focus();}",
				),
			)
		);
	}

	public static function finish_launcher(): void {
		if ( ! is_user_logged_in() ) {
			return;
		}
		?>
		<script id="sml-loop-kick-bridge-js">
		(function () {
			var launcher = document.querySelector('[data-sml-loop-launcher]');
			var label = launcher && launcher.querySelector('.sml-loop-launcher-label');
			if (label) label.textContent = 'LOOP-KICK';
			if (launcher) launcher.setAttribute('aria-label', 'Open LOOP-KICK');
			var popup = document.getElementById('sml-loop-popup');
			if (popup) popup.setAttribute('aria-label', 'LOOP-KICK');
			var frame = document.getElementById('sml-loop-popup-frame');
			if (frame) frame.title = 'LOOP-KICK';
			var close = document.querySelector('[data-sml-loop-popup-close]');
			if (close) close.setAttribute('aria-label', 'Close LOOP-KICK');
		}());
		</script>
		<style id="sml-loop-kick-bridge-css">
		#sml-loop-popup-inner{width:min(520px,100vw)!important;background:#07090b!important}
		</style>
		<?php
	}
}

SML_Loop_Kick_Bridge::boot();
