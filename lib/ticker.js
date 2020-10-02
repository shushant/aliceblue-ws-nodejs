var WebSocket = require('ws')

var ABTicker = function (params) {
	var root =
		params.root || 'wss://ant.aliceblueonline.com/hydrasocket/v2/websocket'

	var read_timeout = 5, // seconds
		reconnect_max_delay = 0,
		reconnect_max_tries = 0,
		// message flags (outgoing)
		mSubscribe = 'subscribe',
		mUnSubscribe = 'unsubscribe',
		mSetMode = 'mode';

	var ws = null,
		triggers = {
			connect: [],
			ticks: [],
			disconnect: [],
			error: [],
			close: [],
			reconnect: [],
			noreconnect: [],
			message: [],
			order_update: [],
		},
		read_timer = null,
		last_read = 0,
		reconnect_timer = null,
		auto_reconnect = false,
		current_reconnection_count = 0,
		last_reconnect_interval = 0,
		current_ws_url = null,
		token_modes = {},
		defaultReconnectMaxDelay = 60,
		defaultReconnectMaxRetries = 50,
		maximumReconnectMaxRetries = 300,
		minimumReconnectMaxDelay = 5

	// segment constants
	var NseCM = 1,
		NseFO = 2,
		NseCD = 3,
		BseCM = 4,
		BseFO = 5,
		BseCD = 6,
		McxFO = 7,
		McxSX = 8,
		Indices = 9

	// Enable auto reconnect by default
	if (!params.reconnect) params.reconnect = true
	autoReconnect(params.reconnect, params.max_retry, params.max_delay)

	this.autoReconnect = function (t, max_retry, max_delay) {
		autoReconnect(t, max_retry, max_delay)
	}

	this.heartbeat = function () {
		// if (!ws) return
		// if (ws.readyState !== 1) return
		send({ a: 'h', v: [], m: '' })
		setInterval(function () {
			// this.heartbeat()
		}, 10000)
	}

	this.connect = function () {
		// Skip if its already connected
		if (ws && (ws.readyState == ws.CONNECTING || ws.readyState == ws.OPEN))
			return

		var url = `${root}?access_token=${params.access_token}`

		ws = new WebSocket(url)

		this.heartbeat()

		ws.binaryType = 'arraybuffer'

		ws.onopen = function () {
			// Reset last reconnect interval
			last_reconnect_interval = null
			// Reset current_reconnection_count attempt
			current_reconnection_count = 0
			// Store current open connection url to check for auto re-connection.
			if (!current_ws_url) current_ws_url = this.url
			// Trigger on connect event
			trigger('connect')
			// If there isn't an incoming message in n seconds, assume disconnection.
			// clearInterval(read_timer)

			last_read = new Date()
			read_timer = setInterval(function () {
				if ((new Date() - last_read) / 1000 >= read_timeout) {
					// reset current_ws_url incase current connection times out
					// This is determined when last heart beat received time interval
					// exceeds read_timeout value
					current_ws_url = null
					if (ws) ws.close()
					clearInterval(read_timer)
					triggerDisconnect()
				}
			}, read_timeout * 1000)
		}

		ws.onmessage = function (e) {
			// Binary tick data.
			if (e.data instanceof ArrayBuffer) {
				if (e.data.byteLength === 86) {
					var d = parseBinary(e.data)
					if (d) trigger('ticks', [d])
				}
			}

			// Set last read time to check for connection timeout
			last_read = new Date()
		}

		ws.onerror = function (e) {
			trigger('error', [e])

			// Force close to avoid ghost connections
			if (this && this.readyState == this.OPEN) this.close()
		}

		ws.onclose = function (e) {
			trigger('close', [e])

			// the ws id doesn't match the current global id,
			// meaning it's a ghost close event. just ignore.
			if (current_ws_url && this.url != current_ws_url) return

			triggerDisconnect(e)
		}
	}

	this.disconnect = function () {
		if (ws && ws.readyState != ws.CLOSING && ws.readyState != ws.CLOSED) {
			ws.close()
		}
	}

	this.connected = function () {
		// console.log('connected')
		if (ws && ws.readyState == ws.OPEN) {
			return true
		} else {
			return false
		}
	}

	this.on = function (e, callback) {
		if (triggers.hasOwnProperty(e)) {
			triggers[e].push(callback)
		}
	}

	this.subscribe = function (tokens) {
		if (tokens.length > 0) {
			// send({ a: mSubscribe, v: tokens })
			send({ a: 'subscribe', v: tokens, m: 'marketdata' })
		}
		return tokens
	}

	this.unsubscribe = function (tokens) {
		if (tokens.length > 0) {
			send({ a: mUnSubscribe, v: tokens })
		}
		return tokens
	}

	this.setMode = function (mode, tokens) {
		if (tokens.length > 0) {
			send({ a: mSetMode, v: [mode, tokens] })
		}
		return tokens
	}

	function autoReconnect(t, max_retry, max_delay) {
		auto_reconnect = t == true ? true : false

		// Set default values
		max_retry = max_retry || defaultReconnectMaxRetries
		max_delay = max_delay || defaultReconnectMaxDelay

		// Set reconnect constraints
		reconnect_max_tries =
			max_retry >= maximumReconnectMaxRetries
				? maximumReconnectMaxRetries
				: max_retry
		reconnect_max_delay =
			max_delay <= minimumReconnectMaxDelay
				? minimumReconnectMaxDelay
				: max_delay
	}

	function triggerDisconnect(e) {
		ws = null
		trigger('disconnect', [e])
		if (auto_reconnect) attemptReconnection()
	}

	// send a message via the socket
	// automatically encodes json if possible
	function send(message) {
		if (!ws || ws.readyState != ws.OPEN) return

		try {
			if (typeof message == 'object') {
				message = JSON.stringify(message)
				console.log(message)
			}
			ws.send(message)
		} catch (e) {
			ws.close()
		}
	}

	// trigger event callbacks
	function trigger(e, args) {
		if (!triggers[e]) return
		for (var n = 0; n < triggers[e].length; n++) {
			triggers[e][n].apply(triggers[e][n], args ? args : [])
		}
	}

	// parse received binary message. each message is a combination of multiple tick packets

	function parseBinary(binpacks) {
		var ticks = []
		var bin = Buffer.from(new Uint8Array(binpacks))
		let exchange_tokens = bin.slice(1, 2)

		var divisor = 100.0

		var tick = {
			exchange_token: buf2long(bin.slice(1, 2)),
			instrument_token: buf2long(bin.slice(2, 6)),
			ltp: buf2long(bin.slice(6, 10)) / divisor,
			// last_price: buf2long(bin.slice(4, 8)) / divisor,
			ohlc: {
				high: buf2long(bin.slice(62, 66)) / divisor,
				low: buf2long(bin.slice(66, 70)) / divisor,
				open: buf2long(bin.slice(70, 74)) / divisor,
				close: buf2long(bin.slice(74, 78)) / divisor,
			},
			// change: buf2long(bin.slice(24, 28)),
		}
		var timestamp = buf2long(bin.slice(10, 14))
		if (timestamp)
			tick.timestamp = new Date(timestamp * 1000).toLocaleString(
				'en-US',
				{ timeZone: 'Asia/Kolkata' },
			)
		// console.log(tick)
		ticks.push(tick)

		return ticks
	}

	function attemptReconnection() {
		// Try reconnecting only so many times.
		if (current_reconnection_count > reconnect_max_tries) {
			trigger('noreconnect')
			process.exit(1)
		}

		if (current_reconnection_count > 0) {
			last_reconnect_interval = Math.pow(2, current_reconnection_count)
		} else if (!last_reconnect_interval) {
			last_reconnect_interval = 1
		}

		if (last_reconnect_interval > reconnect_max_delay) {
			last_reconnect_interval = reconnect_max_delay
		}

		current_reconnection_count++

		trigger('reconnect', [
			current_reconnection_count,
			last_reconnect_interval,
		])

		reconnect_timer = setTimeout(function () {
			self.connect()
		}, last_reconnect_interval * 1000)
	}

	// Big endian byte array to long.
	function buf2long(buf) {
		var b = new Uint8Array(buf),
			val = 0,
			len = b.length

		for (var i = 0, j = len - 1; i < len; i++, j--) {
			val += b[j] << (i * 8)
		}

		return val
	}
	
	var self = this
}

module.exports = KiteTicker