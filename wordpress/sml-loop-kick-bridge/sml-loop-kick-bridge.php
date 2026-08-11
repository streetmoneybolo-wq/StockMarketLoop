<?php
/**
 * Plugin Name: SML LOOP-KICK Bridge
 * Description: Replaces the Loop Messenger launcher with the hosted LOOP-KICK device while preserving the existing messenger as a rollback path.
 * Version: 1.2.0
 * Author: Stock Market Loop
 */

declare( strict_types = 1 );

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

final class SML_Loop_Kick_Bridge {
	private const APP_URL = 'https://stockmarketloop-loop-kick.onrender.com/loop-kick/';
	private const TOKEN_TTL = 12 * HOUR_IN_SECONDS;
	private const TOKEN_META = 'sml_loop_kick_session_token';

	private static string $token = '';

	public static function boot(): void {
		add_filter( 'option_sml_loop_messages_url', array( __CLASS__, 'launcher_url' ), 99 );
		add_filter( 'default_option_sml_loop_messages_url', array( __CLASS__, 'launcher_url' ), 99 );
		add_filter( 'gettext_sml-loop-messenger', array( __CLASS__, 'messenger_text' ), 10, 3 );
		add_action( 'wp_enqueue_scripts', array( __CLASS__, 'enqueue' ), 9999 );
		add_action( 'admin_enqueue_scripts', array( __CLASS__, 'enqueue' ), 9999 );
		add_action( 'template_redirect', array( __CLASS__, 'start_standalone_buffer' ), -1999999 );
		add_action( 'admin_bar_menu', array( __CLASS__, 'admin_bar' ), 999 );
		add_action( 'wp_footer', array( __CLASS__, 'finish_launcher' ), 100 );
		add_action( 'admin_footer', array( __CLASS__, 'admin_surface' ), 100 );
		add_action( 'rest_api_init', array( __CLASS__, 'routes' ) );
		add_action( 'wp_logout', array( __CLASS__, 'revoke_session' ) );
	}

	public static function start_standalone_buffer(): void {
		if ( is_admin() || ! is_user_logged_in() || wp_doing_ajax()
			|| ( defined( 'REST_REQUEST' ) && REST_REQUEST ) || wp_doing_cron() ) {
			return;
		}
		if ( isset( $_SERVER['REQUEST_METHOD'] ) && 'GET' !== strtoupper( sanitize_text_field( wp_unslash( $_SERVER['REQUEST_METHOD'] ) ) ) ) {
			return;
		}
		ob_start( array( __CLASS__, 'inject_standalone_controller' ) );
	}

	public static function inject_standalone_controller( $html ): string {
		if ( ! is_string( $html ) || false !== strpos( $html, 'sml-loop-kick-bridge.js' ) ) {
			return is_string( $html ) ? $html : '';
		}
		$close = strripos( $html, '</body>' );
		if ( false === $close || false === stripos( $html, '<html' ) ) {
			return $html;
		}
		$src = plugins_url( 'assets/loop-kick-bridge.js', __FILE__ ) . '?ver=1.2.0';
		$tag = '<script id="sml-loop-kick-bridge-standalone" data-sml-oh-allow src="' . esc_url( $src ) . '"></script>';
		return substr( $html, 0, $close ) . $tag . substr( $html, $close );
	}

	public static function enqueue(): void {
		if ( ! is_user_logged_in() ) {
			return;
		}
		wp_enqueue_script(
			'sml-loop-kick-bridge',
			plugins_url( 'assets/loop-kick-bridge.js', __FILE__ ),
			array(),
			'1.2.0',
			true
		);
	}

	public static function admin_surface(): void {
		if ( ! is_user_logged_in() || ! class_exists( 'SML_Loop_Entry' ) ) {
			return;
		}
		SML_Loop_Entry::popup();
		self::finish_launcher();
	}

	public static function messenger_text( string $translation, string $text, string $domain ): string {
		if ( 'Messages' === $text ) {
			return 'LOOP-KICK';
		}
		return $translation;
	}

	private static function token(): string {
		if ( self::$token || ! is_user_logged_in() ) {
			return self::$token;
		}

		$user_id = get_current_user_id();
		$saved   = (string) get_user_meta( $user_id, self::TOKEN_META, true );
		if ( preg_match( '/^[a-f0-9]{64}$/', $saved ) ) {
			$identity = get_transient( 'sml_lk_session_' . hash( 'sha256', $saved ) );
			if ( is_array( $identity ) && ( $identity['userId'] ?? '' ) === 'wp-' . $user_id ) {
				self::$token = $saved;
				return self::$token;
			}
		}

		self::$token = bin2hex( random_bytes( 32 ) );
		update_user_meta( $user_id, self::TOKEN_META, self::$token );
		set_transient(
			'sml_lk_session_' . hash( 'sha256', self::$token ),
			array( 'userId' => 'wp-' . $user_id ),
			self::TOKEN_TTL
		);
		return self::$token;
	}

	public static function revoke_session( int $user_id ): void {
		$token = (string) get_user_meta( $user_id, self::TOKEN_META, true );
		if ( preg_match( '/^[a-f0-9]{64}$/', $token ) ) {
			delete_transient( 'sml_lk_session_' . hash( 'sha256', $token ) );
		}
		delete_user_meta( $user_id, self::TOKEN_META );
		self::$token = '';
	}

	public static function launcher_url( $stored ): string {
		if ( ! is_user_logged_in() ) {
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
		<style id="sml-loop-kick-bridge-css">
		#sml-loop-popup-inner{width:min(520px,100vw)!important;background:#07090b!important}
		</style>
		<?php
	}
}

SML_Loop_Kick_Bridge::boot();
