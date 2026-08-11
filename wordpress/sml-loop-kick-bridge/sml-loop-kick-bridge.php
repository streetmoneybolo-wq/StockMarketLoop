<?php
/**
 * Plugin Name: SML LOOP-KICK Bridge
 * Description: Replaces the Loop Messenger launcher with the hosted LOOP-KICK device while preserving the existing messenger as a rollback path.
 * Version: 1.4.5
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
	private const VERSION = '1.4.5';

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
		$src = plugins_url( 'assets/loop-kick-bridge.js', __FILE__ ) . '?ver=' . self::VERSION;
		$tag = self::widget_styles()
			. '<script id="sml-loop-kick-bridge-standalone" data-sml-oh-allow src="' . esc_url( $src ) . '"></script>';
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
			self::VERSION,
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
			array( 'userId' => 'wp-' . $user_id, 'wpUserId' => $user_id ),
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

		register_rest_route(
			'sml-loop-kick/v1',
			'/gateway',
			array(
				'methods'             => array( 'GET', 'POST', 'DELETE' ),
				'callback'            => array( __CLASS__, 'gateway' ),
				'permission_callback' => '__return_true',
			)
		);

		register_rest_route(
			'sml-loop-kick/v1',
			'/upload',
			array(
				'methods'             => WP_REST_Server::CREATABLE,
				'callback'            => array( __CLASS__, 'gateway_upload' ),
				'permission_callback' => '__return_true',
			)
		);
	}

	private static function identity_for_token( string $token ) {
		if ( ! preg_match( '/^[a-f0-9]{64}$/', $token ) ) {
			return new WP_Error( 'sml_lk_invalid_session', 'Invalid session.', array( 'status' => 401 ) );
		}
		$identity = get_transient( 'sml_lk_session_' . hash( 'sha256', $token ) );
		if ( ! is_array( $identity ) || empty( $identity['userId'] ) ) {
			return new WP_Error( 'sml_lk_expired_session', 'Session expired.', array( 'status' => 401 ) );
		}
		$user_id = absint( $identity['wpUserId'] ?? str_replace( 'wp-', '', (string) $identity['userId'] ) );
		if ( ! $user_id || ! get_userdata( $user_id ) ) {
			return new WP_Error( 'sml_lk_invalid_user', 'Invalid session user.', array( 'status' => 401 ) );
		}
		$identity['wpUserId'] = $user_id;
		return $identity;
	}

	private static function request_token( WP_REST_Request $request ): string {
		$token = (string) $request->get_header( 'x-loop-kick-session' );
		if ( ! $token ) {
			$auth = (string) $request->get_header( 'authorization' );
			if ( preg_match( '/^Bearer\s+([^\s]+)$/i', $auth, $match ) ) {
				$token = (string) $match[1];
			}
		}
		return $token ?: (string) $request->get_param( 'token' );
	}

	private static function allowed_route( string $method, string $route ): bool {
		$rules = array(
			'GET' => array(
				'#^/sml-loop/v1/(threads|preferences|poll|chirp/settings|chirp/presence|chirp/incoming)$#',
				'#^/sml-loop/v1/threads/\d+/messages$#',
				'#^/sml-loop/v1/chirp/sessions/\d+/signal$#',
				'#^/sml-mhub/v1/(people|search|notifications)$#',
			),
			'POST' => array(
				'#^/sml-loop/v1/(threads|preferences|chirp/settings|chirp/allow|chirp/presence|chirp/start)$#',
				'#^/sml-loop/v1/threads/\d+/(messages|read|flags|request)$#',
				'#^/sml-loop/v1/chirp/sessions/\d+/(signal|end)$#',
				'#^/sml-mhub/v1/notifications$#',
			),
			'DELETE' => array(
				'#^/sml-loop/v1/threads/\d+/messages$#',
				'#^/sml-loop/v1/messages/\d+$#',
			),
		);
		foreach ( $rules[ $method ] ?? array() as $pattern ) {
			if ( preg_match( $pattern, $route ) ) {
				return true;
			}
		}
		return false;
	}

	private static function profile( int $user_id ): array {
		$user = get_userdata( $user_id );
		if ( ! $user ) {
			return array( 'userId' => $user_id, 'name' => 'Member #' . $user_id, 'handle' => '', 'avatar' => '' );
		}
		$name = function_exists( 'sml_members_handle' ) ? sml_members_handle( $user_id ) : $user->display_name;
		$handle = function_exists( 'sml_members_public_handle' ) ? sml_members_public_handle( $user_id ) : $user->user_login;
		$avatar = (string) get_user_meta( $user_id, 'sml_avatar_url', true );
		if ( ! $avatar ) {
			$avatar = (string) get_avatar_url( $user_id, array( 'size' => 96 ) );
		}
		$presence = class_exists( 'SML_Loop_Presence' ) ? SML_Loop_Presence::get( $user_id ) : array();
		return array(
			'userId'     => $user_id,
			'name'       => sanitize_text_field( (string) $name ),
			'handle'     => ltrim( sanitize_text_field( (string) $handle ), '@' ),
			'avatar'     => esc_url_raw( $avatar ),
			'profileUrl' => esc_url_raw( home_url( '/members/' . $user_id . '/' ) ),
			'presence'   => array(
				'state' => sanitize_key( (string) ( $presence['state'] ?? 'offline' ) ),
				'stale' => ! empty( $presence['stale'] ),
			),
		);
	}

	private static function enrich_threads( $data ): array {
		if ( ! is_array( $data ) || empty( $data['threads'] ) || ! is_array( $data['threads'] ) ) {
			return is_array( $data ) ? $data : array();
		}
		$profiles = array();
		foreach ( $data['threads'] as &$thread ) {
			$thread['people'] = array();
			foreach ( (array) ( $thread['participants'] ?? array() ) as $participant ) {
				$user_id = absint( $participant['user_id'] ?? 0 );
				if ( ! $user_id ) {
					continue;
				}
				if ( ! isset( $profiles[ $user_id ] ) ) {
					$profiles[ $user_id ] = self::profile( $user_id );
				}
				$thread['people'][] = $profiles[ $user_id ];
			}
		}
		unset( $thread );
		return $data;
	}

	public static function gateway( WP_REST_Request $request ) {
		$identity = self::identity_for_token( self::request_token( $request ) );
		if ( is_wp_error( $identity ) ) {
			return $identity;
		}

		$route  = '/' . ltrim( sanitize_text_field( (string) $request->get_param( 'route' ) ), '/' );
		$method = strtoupper( sanitize_key( (string) ( $request->get_param( 'method' ) ?: $request->get_method() ) ) );
		if ( ! self::allowed_route( $method, $route ) ) {
			return new WP_Error( 'sml_lk_route_denied', 'That LOOP-KICK action is not allowed.', array( 'status' => 403 ) );
		}

		$previous = get_current_user_id();
		wp_set_current_user( (int) $identity['wpUserId'] );
		$internal = new WP_REST_Request( $method, $route );
		$params = 'GET' === $method ? $request->get_param( 'query' ) : $request->get_param( 'payload' );
		if ( is_array( $params ) ) {
			$internal->set_query_params( 'GET' === $method ? $params : array() );
			$internal->set_body_params( 'GET' === $method ? array() : $params );
		}
		$response = rest_do_request( $internal );
		wp_set_current_user( $previous );

		if ( is_wp_error( $response ) ) {
			return $response;
		}
		$data = $response->get_data();
		if ( 'GET' === $method && '/sml-loop/v1/threads' === $route ) {
			$data = self::enrich_threads( $data );
		}
		$out = rest_ensure_response( $data );
		$out->set_status( $response->get_status() );
		$out->header( 'Cache-Control', 'no-store, private' );
		return $out;
	}

	public static function gateway_upload( WP_REST_Request $request ) {
		$identity = self::identity_for_token( self::request_token( $request ) );
		if ( is_wp_error( $identity ) ) {
			return $identity;
		}
		$files = $request->get_file_params();
		if ( empty( $files['file'] ) ) {
			return new WP_Error( 'sml_lk_upload_missing', 'No file arrived.', array( 'status' => 400 ) );
		}
		$previous = get_current_user_id();
		wp_set_current_user( (int) $identity['wpUserId'] );
		$internal = new WP_REST_Request( 'POST', '/sml-loop/v1/upload' );
		$internal->set_file_params( array( 'file' => $files['file'] ) );
		$internal->set_body_params( array( 'purpose' => 'image' === (string) $request->get_param( 'purpose' ) ? 'image' : 'voice' ) );
		$response = rest_do_request( $internal );
		wp_set_current_user( $previous );
		return $response;
	}

	public static function verify_session( WP_REST_Request $request ) {
		$identity = self::identity_for_token( (string) $request->get_param( 'token' ) );
		if ( is_wp_error( $identity ) ) {
			return $identity;
		}
		$response = rest_ensure_response(
			array(
				'userId'   => sanitize_text_field( (string) $identity['userId'] ),
				'wpUserId' => (int) $identity['wpUserId'],
				'profile'  => self::profile( (int) $identity['wpUserId'] ),
			)
		);
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
		echo self::widget_styles(); // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped
	}

	private static function widget_styles(): string {
		return '<style id="sml-loop-kick-bridge-css">'
			. '#sml-loop-popup{background:none!important;background-color:transparent!important;'
			. 'background-image:none!important;border:0!important;box-shadow:none!important;'
			. 'backdrop-filter:none!important;filter:none!important;color-scheme:dark!important;'
			. 'pointer-events:none!important}'
			. '#sml-loop-popup-inner{width:min(430px,100vw)!important;height:min(790px,100dvh)!important;'
			. 'background:none!important;background-color:transparent!important;background-image:none!important;'
			. 'border:0!important;box-shadow:none!important;backdrop-filter:none!important;filter:none!important;'
			. 'border-radius:0!important;color-scheme:dark!important;'
			. 'overflow:visible!important;pointer-events:auto!important}'
			. '#sml-loop-popup-frame{display:block!important;background:#020806!important;'
			. 'background-color:#020806!important;background-image:none!important;border:0!important;'
			. 'box-shadow:none!important;color-scheme:dark!important;transition:opacity .16s ease!important;'
			. '-webkit-mask-image:url("data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 viewBox=%270 0 100 100%27 preserveAspectRatio=%27none%27%3E%3Crect x=%2711.7%27 y=%2719.2%27 width=%2781.7%27 height=%2740.4%27 rx=%277%27 ry=%273.8%27 fill=%27white%27/%3E%3Crect x=%2713.5%27 y=%2760.6%27 width=%2778%27 height=%2736.5%27 rx=%276.1%27 ry=%273.3%27 fill=%27white%27/%3E%3C/svg%3E")!important;'
			. 'mask-image:url("data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 viewBox=%270 0 100 100%27 preserveAspectRatio=%27none%27%3E%3Crect x=%2711.7%27 y=%2719.2%27 width=%2781.7%27 height=%2740.4%27 rx=%277%27 ry=%273.8%27 fill=%27white%27/%3E%3Crect x=%2713.5%27 y=%2760.6%27 width=%2778%27 height=%2736.5%27 rx=%276.1%27 ry=%273.3%27 fill=%27white%27/%3E%3C/svg%3E")!important;'
			. '-webkit-mask-position:0 0!important;mask-position:0 0!important;'
			. '-webkit-mask-size:100% 100%!important;mask-size:100% 100%!important;'
			. '-webkit-mask-repeat:no-repeat!important;mask-repeat:no-repeat!important}'
			. '#sml-loop-popup::before,#sml-loop-popup::after,#sml-loop-popup-inner::before,'
			. '#sml-loop-popup-inner::after,#sml-loop-popup-frame::before,#sml-loop-popup-frame::after{'
			. 'content:none!important;display:none!important;background:none!important;border:0!important;'
			. 'box-shadow:none!important;backdrop-filter:none!important}'
			. '#sml-loop-popup::backdrop{background:transparent!important;backdrop-filter:none!important}'
			. '#sml-loop-popup.sml-loop-kick-loading #sml-loop-popup-frame{'
			. 'opacity:0!important;visibility:hidden!important}'
			. '#sml-loop-popup.sml-loop-kick-ready #sml-loop-popup-frame{'
			. 'opacity:1!important;visibility:visible!important}'
			. '[data-sml-loop-popup-close]{display:none!important}'
			. '</style>';
	}
}

SML_Loop_Kick_Bridge::boot();
