'use strict'

const ACTION_DELAY_LONG_MS = [1800, 2800],	// [Min, Max]
	ACTION_DELAY_SHORT_MS = [600, 1000],	// [Min, Max]
	TYPE_NEGOTIATION_PENDING = 35,
	TYPE_NEGOTIATION = 36

module.exports = function Negotiator(mod) {

	let recentDeals = mod.settings.UNATTENDED_MANUAL_NEGOTIATE ? {} : null,
		pendingDeals = [],
		currentDeal = null,
		currentContract = null,
		actionTimeout = null,
		cancelTimeout = null,
		niceName = mod.proxyAuthor !== 'caali' ? '[Nego] ' : ''

	// ############# //
	// ### Hooks ### //
	// ############# //

	mod.hook('S_TRADE_BROKER_DEAL_SUGGESTED', 1, {order: 100, filter: {fake: null}}, event => {
		// Remove old deals that haven't been processed yet
		for(let i = 0; i < pendingDeals.length; i++) {
			let deal = pendingDeals[i]

			if(deal.playerId == event.playerId && deal.listing == event.listing) pendingDeals.splice(i--, 1)
		}

		if(comparePrice(event.offeredPrice, event.sellerPrice) != 0) {
			pendingDeals.push(event)
			queueNextDeal(true)
			return false
		}
		else if(mod.settings.UNATTENDED_MANUAL_NEGOTIATE) {
			let dealId = event.playerId + '-' + event.listing

			if(recentDeals[dealId]) clearTimeout(recentDeals[dealId].timeout)

			recentDeals[dealId] = event
			recentDeals[dealId].timeout = setTimeout(() => { delete recentDeals[dealId] }, 30000)
		}
	})

	mod.hook('S_TRADE_BROKER_REQUEST_DEAL_RESULT', 1, event => {
		if(currentDeal) {
			if(!event.ok) endDeal()

			return false
		}
	})

	mod.hook('S_TRADE_BROKER_DEAL_INFO_UPDATE', 1, event => {
		if(currentDeal) {
			if(event.buyerStage == 2 && event.sellerStage < 2) {
				let deal = currentDeal

				// This abandoned timeout is not a good design, but it's unlikely that it will cause any issues
				setTimeout(() => {
					if(currentDeal && deal.playerId == currentDeal.playerId && deal.listing == currentDeal.listing && BigInt(event.price) >= BigInt(currentDeal.offeredPrice)) {
						mod.toServer('C_TRADE_BROKER_DEAL_CONFIRM', 1, {
							listing: currentDeal.listing,
							stage: event.sellerStage + 1
						})
					}
					else endDeal() // We negotiated the wrong one, whoops! - TODO: Inspect S_REQUEST_CONTRACT.data for price and other info
				}, event.sellerStage == 0 ? rng(ACTION_DELAY_SHORT_MS) : 0)
			}

			return false
		}
	})

	mod.hook('S_REQUEST_CONTRACT', 1, event => {
		if(currentDeal && (event.type == TYPE_NEGOTIATION_PENDING || event.type == TYPE_NEGOTIATION)) {
			currentContract = event
			setEndTimeout()
			return false
		}
	})

	mod.hook('S_REPLY_REQUEST_CONTRACT', 1, replyOrAccept)
	mod.hook('S_ACCEPT_CONTRACT', 1, replyOrAccept)

	mod.hook('S_REJECT_CONTRACT', 1, event => {
		if(currentDeal && (event.type == TYPE_NEGOTIATION_PENDING || event.type == TYPE_NEGOTIATION)) {
			mod.command.message(niceName + currentDeal.name + ' aborted negotiation')
			if(mod.settings.log) console.log(now() + ' [Nego] ' + currentDeal.name + ' aborted negotiation')

			// Fix listing becoming un-negotiable (server-side) if the other user aborts the initial dialog
			if(event.type == TYPE_NEGOTIATION_PENDING)
				mod.toServer('C_TRADE_BROKER_REJECT_SUGGEST', 1, {
					playerId: currentDeal.playerId,
					listing: currentDeal.listing
				})

			currentContract = null
			endDeal()
			return false
		}
	})

	mod.hook('S_CANCEL_CONTRACT', 1, event => {
		if(currentDeal && (event.type == TYPE_NEGOTIATION_PENDING || event.type == TYPE_NEGOTIATION)) {
			currentContract = null
			endDeal()
			return false
		}
	})

	mod.hook('S_SYSTEM_MESSAGE', 1, event => {
		if(currentDeal) {
			try {
				const msg = mod.parseSystemMessage(event.message)

				//if(msg.id === 'SMT_MEDIATE_DISCONNECT_CANCEL_OFFER_BY_ME' || msg.id === 'SMT_MEDIATE_TRADE_CANCEL_ME') return false
				if(msg.id === 'SMT_MEDIATE_TRADE_CANCEL_OPPONENT') {
					mod.command.message(niceName + currentDeal.name + ' cancelled negotiation')
					if(mod.settings.log) console.log(now() + ' [Nego] ' + currentDeal.name + ' cancelled negotiation')
					return false
				}
				else if(msg.id === 'SMT_MEDIATE_SUCCESS_SELL') {
					mod.command.message(niceName + 'Negotiation with ' + currentDeal.name + ' successful')
					if(mod.settings.log) console.log(now() + ' [Nego] Negotiation with ' + currentDeal.name + ' successful')
					return false
				}
			}
			catch(e) {}
		}
	})

	if(mod.settings.UNATTENDED_MANUAL_NEGOTIATE)
		mod.hook('C_REQUEST_CONTRACT', 1, event => {
			if(event.type == 35) {
				let deal = recentDeals[event.data.readUInt32LE(0) + '-' + event.data.readUInt32LE(4)]

				if(deal) {
					currentDeal = deal
					mod.command.message(niceName + 'Handling negotiation with ' + currentDeal.name + '...')
					process.nextTick(() => {
						mod.toClient('S_REPLY_REQUEST_CONTRACT', 1, { type: event.type })
					})
				}
			}
		})

	// ################# //
	// ### Functions ### //
	// ################# //

	function replyOrAccept(event) {
		if(currentDeal && event.type == TYPE_NEGOTIATION_PENDING) {
			setEndTimeout()
			return false
		}
	}

	// 1 = Auto Accept, 0 = No Action, -1 = Auto-decline
	function comparePrice(offer, seller) {
		if(mod.settings.AUTO_ACCEPT_THRESHOLD && BigInt(offer) >= (BigInt(seller) * BigInt(mod.settings.AUTO_ACCEPT_THRESHOLD)) / 100n) return 1
		if(mod.settings.AUTO_REJECT_THRESHOLD && BigInt(offer) < (BigInt(seller) * BigInt(mod.settings.AUTO_REJECT_THRESHOLD)) / 100n) return -1
		return 0
	}

	function queueNextDeal(slow) {
		if(!actionTimeout && !currentDeal)
			actionTimeout = setTimeout(tryNextDeal, mod.settings.DELAY_ACTIONS ? rng(slow ? ACTION_DELAY_LONG_MS : ACTION_DELAY_SHORT_MS) : 0)
	}

	function tryNextDeal() {
		actionTimeout = null

		if(!(currentDeal = pendingDeals.shift())) return

		if(comparePrice(currentDeal.offeredPrice, currentDeal.sellerPrice) == 1) {
			mod.command.message(niceName + 'Attempting to negotiate with ' + currentDeal.name + ' for ' + conv(currentDeal.item) + '(' + currentDeal.amount + ')...')
			mod.command.message(niceName + 'Price: ' + formatGold(currentDeal.sellerPrice) + ' - Offered: ' + formatGold(currentDeal.offeredPrice))
			if(mod.settings.log) console.log(now() + ' [Nego] Attempting to negotiate with ' + currentDeal.name + ' for ' + conv(currentDeal.item) + '(' + currentDeal.amount + ')...\n'
				+ '             Price: ' + formatGoldConsole(currentDeal.sellerPrice) + ' - Offered: ' + formatGoldConsole(currentDeal.offeredPrice))

			const data = Buffer.alloc(30)
			data.writeUInt32LE(currentDeal.playerId, 0)
			data.writeUInt32LE(currentDeal.listing, 4)

			mod.toServer('C_REQUEST_CONTRACT', 1, {
				type: 35,
				unk2: 0,
				unk3: 0,
				unk4: 0,
				name: '',
				data
			})
		}
		else {
			mod.toServer('C_TRADE_BROKER_REJECT_SUGGEST', 1, {
				playerId: currentDeal.playerId,
				listing: currentDeal.listing
			})

			mod.command.message(niceName + 'Declined negotiation from ' + currentDeal.name + ' for ' + conv(currentDeal.item) + '(' + currentDeal.amount + ')')
			mod.command.message(niceName + 'Price: ' + formatGold(currentDeal.sellerPrice) + ' - Offered: ' + formatGold(currentDeal.offeredPrice))
			if(mod.settings.log) console.log(now() + ' [Nego] Declined negotiation from ' + currentDeal.name + ' for ' + conv(currentDeal.item) + '(' + currentDeal.amount + ')\n'
				+ '             Price: ' + formatGoldConsole(currentDeal.sellerPrice) + ' - Offered: ' + formatGoldConsole(currentDeal.offeredPrice))

			currentDeal = null
			queueNextDeal()
		}
	}

	function setEndTimeout() {
		clearTimeout(cancelTimeout)
		cancelTimeout = setTimeout(endDeal, pendingDeals.length ? 15000 : 30000)
	}

	function endDeal() {
		clearTimeout(cancelTimeout)

		if(currentContract) {
			mod.command.message(niceName + 'Negotiation timed out')
			if(mod.settings.log) console.log(now() + ' [Nego] Negotiation timed out')

			mod.toServer('C_CANCEL_CONTRACT', 1, {
				type: currentContract.type,
				id: currentContract.id
			})
			currentContract = null
			setEndTimeout()
			return
		}

		currentDeal = null
		queueNextDeal()
	}

	function formatGold(gold) {
		gold = gold.toString()

		let str = ''
		if(gold.length > 4) str += '<font color="#ffb033">' + Number(gold.slice(0, -4)).toLocaleString() + 'g</font>'
		if(gold.length > 2) str += '<font color="#d7d7d7">' + gold.slice(-4, -2) + 's</font>'
		str += '<font color="#c87551">' + gold.slice(-2) + 'c</font>'

		return str
	}

	function formatGoldConsole(gold) {
		gold = gold.toString()

		let str = ''
		if(gold.length > 4) str += Number(gold.slice(0, -4)).toLocaleString() + 'g'
		if(gold.length > 2) str += gold.slice(-4, -2) + 's'
		str += gold.slice(-2) + 'c'

		return str
	}

	function rng([min, max]) {
		return min + Math.floor(Math.random() * (max - min + 1))
	}

	function now() { 
		return new Date().toLocaleTimeString().replace(/([\d]+:[\d]{2})(:[\d]{2})(.*)/, "$1$3")
	}

	function conv(s) {
		const data = mod.game.data.items.get(s)
		return data ? data.name : "Undefined"
	}

	// ################ //
	// ### Commands ### //
	// ################ //

	mod.command.add('nego', (cmd, value) => {
		switch (cmd) {
			case "accept":
				if(value) {
					mod.settings.AUTO_ACCEPT_THRESHOLD = Number(value)
					mod.command.message(niceName + 'Auto accept threshold set to <font color="#F0E442">' + mod.settings.AUTO_ACCEPT_THRESHOLD + '</font>')
					console.log('[Nego] Auto accept threshold set to ' + mod.settings.AUTO_ACCEPT_THRESHOLD)
				}
				break
			case "decline":
			case "reject":
				if(value) {
					mod.settings.AUTO_REJECT_THRESHOLD = Number(value)
					mod.command.message(niceName + 'Auto reject threshold set to <font color="#F0E442">' + mod.settings.AUTO_REJECT_THRESHOLD + '</font>')
					console.log('[Nego] Auto reject threshold set to ' + mod.settings.AUTO_REJECT_THRESHOLD)
				}
				break
			case "unattended":
				mod.settings.UNATTENDED_MANUAL_NEGOTIATE = !mod.settings.UNATTENDED_MANUAL_NEGOTIATE
				mod.command.message(niceName + 'Unattended manual negotiation ' + (mod.settings.UNATTENDED_MANUAL_NEGOTIATE ? '<font color="#56B4E9">enabled</font>' : '<font color="#E69F00">disabled</font>'))
				console.log('[Nego] Unattended manual negotiation ' + (mod.settings.UNATTENDED_MANUAL_NEGOTIATE ? 'enabled' : 'disabled'))
				break
			case "delay":
				mod.settings.DELAY_ACTIONS = !mod.settings.DELAY_ACTIONS
				mod.command.message(niceName + 'Human-like behavior ' + (mod.settings.DELAY_ACTIONS ? '<font color="#56B4E9">enabled</font>' : '<font color="#E69F00">disabled</font>'))
				console.log('[Nego] Human-like behavior ' + (mod.settings.DELAY_ACTIONS ? 'enabled' : 'disabled'))
				break
			case "log":
				mod.settings.log = !mod.settings.log
				mod.command.message(niceName + 'Logging to console ' + (mod.settings.log ? '<font color="#56B4E9">enabled</font>' : '<font color="#E69F00">disabled</font>'))
				console.log('[Nego] Logging to console ' + (mod.settings.log ? 'enabled' : 'disabled'))
				break
			default:
				mod.command.message('Commands:\n' 
					+ ' "nego accept [x]" (change the minimum percentage to accept a deal, e.g. "nego accept 100" [0 to disable])\n'
					+ ' "nego reject [x]" (change the maximum percentage to reject a deal, e.g. "nego reject 75" [0 to disable])\n'
					+ ' "nego unattended" (enable/disable automatically accepting deals after clicking the "Accept" link in chat)\n'
					+ ' "nego delay" (switch between human-like behavior and immediate negotiation)\n'
					+ ' "nego log" (enable/disable logging to console)'
				)
		}
	})
}