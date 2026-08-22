import { InstanceBase, InstanceStatus, Regex, TCPHelper } from '@companion-module/base'
import { getFeedbacks } from './feedbacks.js'

export const UpgradeScripts = []

//Short names for the 6 input plug types, indexed to match INplg's values and the "Plug" dropdown.
const PLUG_NAMES = ['VGA', 'DVI-A', 'DVI', 'SDI', 'HDMI', 'DisplayPort']

//Decodes VEupd's firmware version into a readable string, e.g. 67239971 -> "4.02.23"
//Each field is BCD-encoded (its hex digits are the decimal digits), not a plain binary number.
function decodeFirmwareVersion(raw) {
	const isBeta = (raw >>> 31) & 1
	const major = parseInt(((raw >>> 24) & 0x7f).toString(16), 10)
	const minor = ((raw >>> 16) & 0xff).toString(16).padStart(2, '0')
	const build = (raw & 0xffff).toString(16)
	return `${major}.${minor}.${build}` + (isBeta ? ' BETA' : '')
}

export default class LiveCore extends InstanceBase {
	constructor(internal) {
		super(internal)
	}

	init(config) {
		let self = this
		this.config = config

		this.firmwareVersion = '0'
		this.numOutputs = 0
		this.numInputs = 0
		this.modelnum
		this.modelname = ''
		this.isSimulator = false
		this.tallyPGM = Array.from({ length: 49 }, () => 0)
		this.tallyPVW = Array.from({ length: 49 }, () => 0)
		this.activeScreen = Array.from({ length: 8 }, () => 0)
		// Raw per-buffer memory identity, as reported by PIpid. Buffer 0/1 do not
		// correspond to PGM/PVW directly - which buffer is live in program depends
		// on the take/t-bar status (SPCtb), so PGM/PVW have to be derived, see updatePresetMemories().
		this.memoriesBuf0 = Array.from({ length: 8 }, () => 255)
		this.memoriesBuf1 = Array.from({ length: 8 }, () => 255)
		this.programBuffer = Array.from({ length: 8 }, () => 0)
		this.memoriesPGM = Array.from({ length: 8 }, () => 255)
		this.memoriesPVW = Array.from({ length: 8 }, () => 255)
		this.screenNameChars = Array.from({ length: 8 }, () => [])
		this.screenNames = Array.from({ length: 8 }, () => '')
		// LiveCore supports up to 8 screens (across up to 2 stacked devices), but not all of them
		// necessarily exist - SPise tells us which ones are actually enabled, see updateVariableDefinitions().
		this.screenEnabled = Array.from({ length: 8 }, () => false)
		// Sticky version of screenEnabled: set once a screen is first seen enabled, never reset -
		// used to keep that screen's variables declared even if it later goes into confidence mode
		// (which makes SPise report it as disabled), see updateVariableDefinitions().
		this.screenKnownToExist = Array.from({ length: 8 }, () => false)

		// Master preset memories (up to 144) - unlike regular preset memories, the protocol exposes
		// a validity flag (PSval) for these, so the "Load Master Memory" dropdown can be limited to
		// slots that actually have something saved, labelled with their name (LBPSe).
		this.masterMemoryValid = Array.from({ length: 144 }, () => false)
		this.masterMemoryNameChars = Array.from({ length: 144 }, () => [])
		this.masterMemoryNames = Array.from({ length: 144 }, () => '')

		// Regular preset memories (up to 144) have no validity flag, so unlike master memories
		// the "Load Memory" dropdown can't be limited to slots that are actually saved - all 144
		// are listed, labelled with their name (LBPMe) if known.
		this.presetMemoryNameChars = Array.from({ length: 144 }, () => [])
		this.presetMemoryNames = Array.from({ length: 144 }, () => '')

		// Confidence memories (up to 16) and monitoring memories (up to 8) also have no validity
		// flag, so all slots are listed, labelled with their name if known.
		this.confidenceMemoryNameChars = Array.from({ length: 16 }, () => [])
		this.confidenceMemoryNames = Array.from({ length: 16 }, () => '')
		this.monitoringMemoryNameChars = Array.from({ length: 8 }, () => [])
		this.monitoringMemoryNames = Array.from({ length: 8 }, () => '')

		// Device-wide diagnostic values, exposed as device.* variables.
		this.deviceFirmware = ''
		this.deviceControllers = 0
		this.deviceFanAlarm = 0
		this.deviceTemperatureAlarm = false
		this.deviceReady = false

		// Up to 24 inputs (12 on the master device, another 12 on a linked slave device) - INava
		// tells us which actually exist, so the "Input" dropdowns only list real inputs.
		this.inputAvailable = Array.from({ length: 24 }, () => false)
		// An input's name (LBInp) depends on which of its 6 plugs is currently active (INplg) -
		// only the active plug has a meaningful name, others are blank or a generic placeholder.
		this.inputActivePlug = Array.from({ length: 24 }, () => 0)
		this.inputNameChars = Array.from({ length: 24 }, () => [])
		this.inputNames = Array.from({ length: 24 }, () => '')
		// Which of the 6 plug types are actually available on each input (INpav), used for the
		// "Available Input Plugs" info text on the "Switch input plug" action.
		this.inputPlugAvailable = Array.from({ length: 24 }, () => Array.from({ length: 6 }, () => false))

		// Screen resolution and confidence-mode status, exposed as S{n}.width/height/isconfidence.
		this.screenWidth = Array.from({ length: 8 }, () => 0)
		this.screenHeight = Array.from({ length: 8 }, () => 0)
		this.screenIsConfidence = Array.from({ length: 8 }, () => false)

		// A screen can span up to 4 physical outputs (a "canvas") - a separate dimension from
		// screens. OUava tells us which of the up to 8 outputs actually exist.
		this.outputAvailable = Array.from({ length: 8 }, () => false)
		this.outputActive = Array.from({ length: 8 }, () => false)
		this.outputHdcp = Array.from({ length: 8 }, () => false)
		this.outputNameChars = Array.from({ length: 8 }, () => [])
		this.outputNames = Array.from({ length: 8 }, () => '')

		this.updateVariableDefinitions()
		this.updateStatus(InstanceStatus.Connecting)

		/**
		 * Generic callback function
		 * it generates the command from the name of the action and the options
		 * @param {*} action
		 */
		this.actioncb = (action) => {
			let cmd = ''
			if (action.options && Object.keys(action.options).length > 0) {
				for (let i = 0; i <= 5; i++) {
					if (action.options.hasOwnProperty(i) && action.options[i] != '') {
						cmd += action.options[i] + ','
					}
				}
				if (action.options.hasOwnProperty('value') && action.options['value'] != '') {
					cmd += action.options['value']
				}
			}
			cmd += action.actionId
			self.sendcmd(cmd)
		}

		/**
		 * Sends the command to the Livecore
		 * @param {string} cmd
		 */
		this.sendcmd = (cmd) => {
			if (cmd === undefined || cmd === '') {
				this.log('debug', 'Trying to send empty command')
				return
			}

			cmd += '\n'
			if (self.socket === undefined) {
				self.init_tcp()
			}

			this.log('debug', 'sending tcp ' + cmd + ' to ' + self.config.host)

			if (self.socket !== undefined && self.socket.isConnected) {
				self.socket.send(cmd)
			} else {
				this.log('debug', 'Socket not connected :(')
			}
		}

		self.init_tcp()
		self.actions() // export actions
		this.setFeedbackDefinitions(getFeedbacks(this))
	}

	configUpdated(config) {
		let oldhost = this.config.host
		if (config.host == '') config.host = '192.168.2.140'
		this.config = config
		if (oldhost !== config.host) {
			this.init_tcp()
		}
	}

	_receiveline(line) {
		let self = this
		this.log('debug', 'Received line from Livecore: ' + line)

		if (line.match(/(TPcon|ITcct)\d,\d+/)) {
			// TPcon is the greeting on the documented TPP port (usually 10600), ITcct is the
			// equivalent greeting on the richer, undocumented internal port (usually 10500) -
			// same argument format (device index, connected controller count) either way.
			const greeting = line.match(/TPcon/) ? 'TPcon' : 'ITcct'
			if (line.match(new RegExp(greeting + '0,\\d+')) == null) {
				self.log(
					'error',
					'Connected to ' + self.label + ', but this is not the master of stacked configuation! Closing connection now.'
				)
				self.socket.destroy()
			}
			let connectedDevices = parseInt(line.match(new RegExp(greeting + '0,(\\d)'))[1])
			self.setVariableValues({ 'device.controllers': connectedDevices })
			if (connectedDevices < 4) {
				self.log('info', self.label + ' has ' + (connectedDevices - 1) + ' other connected controller(s).')
				self.sendcmd('?')
			} else if (connectedDevices == 4) {
				self.log('warn', self.label + ' has 4 other connected controllers. Maximum reached.')
				self.sendcmd('?')
			} else {
				self.log(
					'error',
					self.label +
						' connections limit has been reached! Max 5 controllers possible, but it is ' +
						connectedDevices +
						'! Closing connection now.'
				)
				self.socket.destroy() // TODO: there should be a possibility for the user to reconnect
			}
		} else if (line.match(/DEV\d+/)) {
			this.model = parseInt(line.match(/DEV(\d+)/)[1])
			switch (this.model) {
				case 97:
					this.modelname = 'NeXtage 16'
					break
				case 98:
					this.modelname = 'SmartMatriX Ultra'
					break
				case 99:
					this.modelname = 'Ascender 32'
					break
				case 100:
					this.modelname = 'Ascender 48'
					break
				case 102:
					this.modelname = 'Output Expander 16'
					break
				case 103:
					this.modelname = 'Output Expander 32'
					break
				case 104:
					this.modelname = 'Output Expander 48'
					break
				case 105:
					this.modelname = 'NeXtage 16 - 4K'
					break
				case 106:
					this.modelname = 'SmartMatriX Ultra - 4K'
					break
				case 107:
					this.modelname = 'Ascender 32 - 4K'
					break
				case 108:
					this.modelname = 'Ascender 48 - 4K'
					break
				case 112:
					this.modelname = 'Ascender 16'
					break
				case 113:
					this.modelname = 'Ascender 16 - 4K'
					break
				case 114:
					this.modelname = 'Ascender 48 - 4K - PL'
					break
				case 115:
					this.modelname = 'Output Expander 48 - 4K  - PL'
					break
				case 116:
					this.modelname = 'NeXtage 08'
					break
				case 117:
					this.modelname = 'NeXtage 08 - 4K'
					break
				case 118:
					this.modelname = 'Ascender 32 - 4K -PL'
					break
				case 119:
					this.modelname = 'Output Expander 32 - 4K - PL'
					break
				default:
					this.modelname = `unknown (${this.model})`
					break
			}
			self.log('info', self.label + ' Type is ' + this.modelname)
			self.sendcmd('0,TPver')
			self.sendcmd('SIdev')
		} else if (line.match(/SIdev\d+$/)) {
			//Whether this connection is talking to a real device or the AW_SIMULATOR
			this.isSimulator = line.replace('SIdev', '') === '1'
		} else if (line.match(/VEupd\d+,\d+$/)) {
			//Device firmware version (bit-packed, see decodeFirmwareVersion). Needs the device index prefix.
			const raw = Number(line.replace('VEupd', '').split(',')[1])
			this.deviceFirmware = decodeFirmwareVersion(raw)
			this.setVariableValues({ 'device.firmware': this.deviceFirmware })
		} else if (line.match(/PCdgs\d+$/)) {
			//Device global state - 255 = ready, anything else is some other/unknown state. No device index prefix.
			this.deviceReady = line.replace('PCdgs', '') === '255'
			this.setVariableValues({ 'device.ready': this.deviceReady })
		} else if (line.match(/TEdal\d+,\d+$/)) {
			//Temperature alarm status of the device (0 = none, otherwise some alarm level is active, see ENUM_TEMP_ALARM_LVL). Needs the device index prefix.
			const value = line.replace('TEdal', '').split(',')[1]
			this.deviceTemperatureAlarm = value !== '0'
			this.setVariableValues({ 'device.temperature_alarm': this.deviceTemperatureAlarm })
		} else if (line.match(/FAalm\d+,(0|1)$/)) {
			//Fan alarm status of the device (1 = a fan alarm is raised). Needs the device index prefix.
			this.deviceFanAlarm = line.replace('FAalm', '').split(',')[1] === '1'
			this.setVariableValues({ 'device.fan_alarm': this.deviceFanAlarm })
		} else if (line.match(/INava\d+,(0|1)$/)) {
			//Whether an input actually exists (12 without a linked slave device, 24 with)
			const [input, available] = line.replace('INava', '').split(',')
			const wasAvailable = this.inputAvailable[Number(input)]
			this.inputAvailable[Number(input)] = available === '1'
			if (this.inputAvailable[Number(input)] !== wasAvailable) {
				this.actions() // rebuild action definitions, e.g. the input dropdowns
				if (this.inputAvailable[Number(input)]) {
					//Only query further detail once we know the input actually exists
					this.sendcmd(input + ',INplg')
					for (let p = 0; p < 6; p += 1) {
						this.sendcmd(input + ',' + p + ',INpav')
					}
				}
			}
		} else if (line.match(/INpav\d+,\d+,(0|1)$/)) {
			//Whether a given plug is available on an input, used for the "Available Input Plugs" info text
			const [input, plug, available] = line.replace('INpav', '').split(',')
			this.inputPlugAvailable[Number(input)][Number(plug)] = available === '1'
			this.actions() // rebuild action definitions, e.g. the plug availability info text
		} else if (line.match(/INplg\d+,\d+$/)) {
			//Which of the 6 plugs is currently active on an input - the name (LBInp) depends on this
			const [input, plug] = line.replace('INplg', '').split(',')
			this.inputActivePlug[Number(input)] = Number(plug)
			this.actions() // rebuild action definitions, e.g. the input dropdown label's plug name
			for (let c = 0; c < 16; c += 1) {
				this.sendcmd(input + ',' + plug + ',' + c + ',LBInp')
			}
		} else if (line.match(/LBInp\d+,\d+,\d+,\d+$/)) {
			//One character (as ASCII code) of an input's name, 16 chars max, NUL-terminated if shorter.
			//Only meaningful for the currently active plug (see INplg above) - ignore stale queries for
			//a plug that is no longer active.
			const [input, plug, charIndex, code] = line.replace('LBInp', '').split(',').map(Number)
			if (plug !== this.inputActivePlug[input]) return
			this.inputNameChars[input][charIndex] = code
			let name = ''
			for (const c of this.inputNameChars[input]) {
				if (c === undefined || c === 0) break
				name += String.fromCharCode(c)
			}
			if (this.inputNames[input] !== name) {
				this.inputNames[input] = name
				this.actions() // rebuild action definitions, e.g. the input dropdown labels
			}
		} else if (line.match(/OUava\d+,(0|1)$/)) {
			//Whether an output actually exists. A screen/canvas can span up to 4 outputs - a separate
			//dimension from screens, up to 8 outputs total across up to 2 stacked devices.
			const [output, available] = line.replace('OUava', '').split(',')
			const wasAvailable = this.outputAvailable[Number(output)]
			this.outputAvailable[Number(output)] = available === '1'
			if (this.outputAvailable[Number(output)] !== wasAvailable) {
				this.updateVariableDefinitions()
				if (this.outputAvailable[Number(output)]) {
					//Only query further detail once we know the output actually exists
					this.sendcmd(output + ',OUena')
					this.sendcmd(output + ',OUihc')
					for (let c = 0; c < 16; c += 1) {
						this.sendcmd(output + ',' + c + ',LBOut')
					}
				}
			}
		} else if (line.match(/OUena\d+,(0|1)$/)) {
			//Whether an output is currently active
			const [output, active] = line.replace('OUena', '').split(',')
			this.outputActive[Number(output)] = active === '1'
			this.setVariableValues({ [`Out${Number(output) + 1}.active`]: this.outputActive[Number(output)] })
		} else if (line.match(/OUihc\d+,(0|1)$/)) {
			//HDCP status for an output (1 = signal is HDCP-encrypted)
			const [output, hdcp] = line.replace('OUihc', '').split(',')
			this.outputHdcp[Number(output)] = hdcp === '1'
			this.setVariableValues({ [`Out${Number(output) + 1}.hdcp`]: this.outputHdcp[Number(output)] })
		} else if (line.match(/LBOut\d+,\d+,\d+$/)) {
			//One character (as ASCII code) of an output's name, 16 chars max, NUL-terminated if shorter
			const [output, charIndex, code] = line.replace('LBOut', '').split(',').map(Number)
			this.outputNameChars[output][charIndex] = code
			let name = ''
			for (const c of this.outputNameChars[output]) {
				if (c === undefined || c === 0) break
				name += String.fromCharCode(c)
			}
			if (this.outputNames[output] !== name) {
				this.outputNames[output] = name
				this.setVariableValues({ [`Out${output + 1}.name`]: name })
			}
		} else if (line.match(/TPver\d+/)) {
			let commandSetVersion = parseInt(line.match(/TPver\d+,(\d+)/)[1])
			self.log('info', 'Command set version of ' + self.label + ' is ' + commandSetVersion)
			// Device-wide diagnostic values for the device.* variables
			self.sendcmd('0,VEupd')
			self.sendcmd('PCdgs')
			self.sendcmd('0,TEdal')
			self.sendcmd('0,FAalm')
			// Query which of the up to 24 inputs actually exist (12 without a linked slave device, 24 with)
			for (let i = 0; i < 24; i += 1) {
				self.sendcmd(i + ',INava')
			}
			// Query which of the up to 8 outputs actually exist (a screen/canvas can span up to 4 -
			// this is a separate dimension from screens). Further detail is only queried once known to exist.
			for (let o = 0; o < 8; o += 1) {
				self.sendcmd(o + ',OUava')
			}
			// Actually here we would need to check if a parameter readback is ongoing, but TPdie does always give value 1, so just read status of tallies
			for (let i = 1; i < 42; i += 1) {
				self.sendcmd(i + ',TAopr')
				self.sendcmd(i + ',TAopw')
			}
			// Query which of the 8 possible screens actually exist first. The rest of the
			// per-screen state (and the expensive 16-character name readback) is only queried
			// for screens that come back enabled, see the SPise handling below.
			self.log('info', 'Querying SPise for 8 screens')
			for (let i = 0; i < 8; i += 1) {
				self.sendcmd(i + ',SPise')
			}
			self.log('info', 'Done querying SPise')
			// Query which master preset memory slots are actually valid/saved. Names are only
			// queried for slots that come back valid, see the PSval handling below.
			for (let m = 0; m < 144; m += 1) {
				self.sendcmd(m + ',PSval')
			}
			// Regular preset memories have no validity flag, so query all 144 names upfront.
			self.log('info', 'Querying LBPMe names for 144 preset memories')
			for (let m = 0; m < 144; m += 1) {
				for (let c = 0; c < 16; c += 1) {
					self.sendcmd(m + ',' + c + ',LBPMe')
				}
			}
			self.log('info', 'Done querying LBPMe')
			// Confidence memories (up to 16) and monitoring memories (up to 8) also have no
			// validity flag, so query all their names upfront too.
			for (let m = 0; m < 16; m += 1) {
				for (let c = 0; c < 16; c += 1) {
					self.sendcmd(m + ',' + c + ',CMlab')
				}
			}
			for (let m = 0; m < 8; m += 1) {
				for (let c = 0; c < 16; c += 1) {
					self.sendcmd(m + ',' + c + ',LBMMo')
				}
			}
		} else if (line.match(/TPdie0/)) {
			//There is no parameter readback runnning, it can be started now
			self.sendcmd('1TPdie')
		} else if (line.match(/E\d{2}/)) {
			switch (parseInt(line.match(/E(\d{2})/)[1])) {
				case 10:
					self.log('error', 'Received command name error from ' + self.label + ': ' + line)
					break
				case 11:
					self.log('error', 'Received index value out of range error from ' + self.label + ': ' + line)
					break
				case 12:
					self.log('error', 'Received index count (too few or too much) error from ' + self.label + ': ' + line)
					break
				case 13:
					self.log('error', 'Received value out of range error from ' + self.label + ': ' + line)
					break
				default:
					self.log('error', 'Received unspecified error from Livecore ' + self.label + ': ' + line)
			}
		} else if (line.match(/TAopr\d+,(0|1)$/)) {
			//Program Tally Information
			const [input, used] = line.replace('TAopr', '').split(',')
			this.tallyPGM[Number(input)] = Number(used)
			this.checkFeedbacks('input_used')
		} else if (line.match(/TAopw\d+,(0|1)$/)) {
			//Preview Tally information
			const [input, used] = line.replace('TAopw', '').split(',')
			this.tallyPVW[Number(input)] = Number(used)
			this.checkFeedbacks('input_used')
		} else if (line.match(/SPscl\d+,(0|1)$/)) {
			//Information about selected screens for global take
			const [screen, selected] = line.replace('SPscl', '').split(',')
			this.activeScreen[Number(screen)] = Number(selected)
			this.setVariableValues({ [`S${Number(screen) + 1}.globaltake`]: Number(selected) === 1 })
			this.checkFeedbacks('screen_active')
		} else if (line.match(/PIpid\d+,0,\d+$/)) {
			//Information about the memory loaded into preset buffer 0 of a screen
			const [screen, _buffer, memory] = line.replace('PIpid', '').split(',')
			this.memoriesBuf0[Number(screen)] = Number(memory)
			this.updatePresetMemories()
		} else if (line.match(/PIpid\d+,1,\d+$/)) {
			//Information about the memory loaded into preset buffer 1 of a screen
			const [screen, _buffer, memory] = line.replace('PIpid', '').split(',')
			this.memoriesBuf1[Number(screen)] = Number(memory)
			this.updatePresetMemories()
		} else if (line.match(/(SPCtb|GCtba)\d+,\d+$/)) {
			//Take/t-bar status: which preset buffer (0 or 1) is currently live in program for a screen.
			//SPCtb is the settled position after a discrete take (0 or 65535); GCtba is the live
			//analog position while a t-bar is being dragged (e.g. from the operator UI), same value
			//range. A take swaps program/preview without re-announcing PIpid, so this has to be tracked
			//separately.
			const command = line.match(/SPCtb/) ? 'SPCtb' : 'GCtba'
			const [screen, value] = line.replace(command, '').split(',')
			this.programBuffer[Number(screen)] = Number(value) < 32768 ? 0 : 1
			this.setVariableValues({ [`S${Number(screen) + 1}.t-bar`]: Number(value) < 32768 ? 'down' : 'up' })
			this.updatePresetMemories()
		} else if (line.match(/SCssh\d+,\d+$/)) {
			//Screen width status (pixels). Note this doesn't account for an active AOI, which can
			//reduce the effective visible area without changing this value.
			const [screen, width] = line.replace('SCssh', '').split(',')
			this.screenWidth[Number(screen)] = Number(width)
			this.setVariableValues({ [`S${Number(screen) + 1}.width`]: Number(width) })
		} else if (line.match(/SCssv\d+,\d+$/)) {
			//Screen height status (lines)
			const [screen, height] = line.replace('SCssv', '').split(',')
			this.screenHeight[Number(screen)] = Number(height)
			this.setVariableValues({ [`S${Number(screen) + 1}.height`]: Number(height) })
		} else if (line.match(/SCico\d+,(0|1)$/)) {
			//Confidence mode status for a screen (1 = screen is confidential)
			const [screen, active] = line.replace('SCico', '').split(',')
			this.screenIsConfidence[Number(screen)] = active === '1'
			this.setVariableValues({ [`S${Number(screen) + 1}.isconfidence`]: this.screenIsConfidence[Number(screen)] })
		} else if (line.match(/LBScr\d+,\d+,\d+$/)) {
			//One character (as ASCII code) of a screen's name, 16 chars max, NUL-terminated if shorter
			const [screen, charIndex, code] = line.replace('LBScr', '').split(',').map(Number)
			this.screenNameChars[screen][charIndex] = code
			let name = ''
			for (const c of this.screenNameChars[screen]) {
				if (c === undefined || c === 0) break
				name += String.fromCharCode(c)
			}
			if (this.screenNames[screen] !== name) {
				this.screenNames[screen] = name
				this.setVariableValues({ [`S${screen + 1}.name`]: name })
				this.actions() // rebuild action definitions, e.g. screen dropdown labels
			}
		} else if (line.match(/SPise\d+,(0|1)$/)) {
			//Whether a screen actually exists (has outputs and isn't a confidence screen).
			//LiveCore supports up to 8 screens across up to 2 stacked devices, but not all of them
			//necessarily exist, so variables are only declared for the screens that do.
			this.log('info', 'Received ' + line)
			try {
				const [screen, enabled] = line.replace('SPise', '').split(',')
				const wasEnabled = this.screenEnabled[Number(screen)]
				this.screenEnabled[Number(screen)] = enabled === '1'
				if (this.screenEnabled[Number(screen)]) {
					this.screenKnownToExist[Number(screen)] = true
				}
				if (this.screenEnabled[Number(screen)] !== wasEnabled) {
					this.updateVariableDefinitions()
					this.actions() // rebuild action definitions, e.g. the per-screen dropdowns
					if (this.screenEnabled[Number(screen)]) {
						//Only query the rest of a screen's state once we know it actually exists
						this.sendcmd(screen + ',SPscl')
						this.sendcmd(screen + ',0,PIpid')
						this.sendcmd(screen + ',1,PIpid')
						this.sendcmd(screen + ',SPCtb')
						this.sendcmd(screen + ',SCssh')
						this.sendcmd(screen + ',SCssv')
						this.sendcmd(screen + ',SCico')
						for (let c = 0; c < 16; c += 1) {
							this.sendcmd(screen + ',' + c + ',LBScr')
						}
					}
				}
			} catch (err) {
				this.log('error', 'Failed to handle ' + line + ': ' + err.stack)
			}
		} else if (line.match(/PSval\d+,(0|1)$/)) {
			//Whether a master preset memory slot actually has something saved to it.
			const [memory, valid] = line.replace('PSval', '').split(',')
			const wasValid = this.masterMemoryValid[Number(memory)]
			this.masterMemoryValid[Number(memory)] = valid === '1'
			if (this.masterMemoryValid[Number(memory)] !== wasValid) {
				this.actions() // rebuild action definitions, e.g. the master memory dropdown
				if (this.masterMemoryValid[Number(memory)]) {
					//Only query the name of a master memory once we know it is actually saved
					for (let c = 0; c < 16; c += 1) {
						this.sendcmd(memory + ',' + c + ',LBPSe')
					}
				}
			}
		} else if (line.match(/LBPSe\d+,\d+,\d+$/)) {
			//One character (as ASCII code) of a master preset memory's name, 16 chars max, NUL-terminated if shorter
			const [memory, charIndex, code] = line.replace('LBPSe', '').split(',').map(Number)
			this.masterMemoryNameChars[memory][charIndex] = code
			let name = ''
			for (const c of this.masterMemoryNameChars[memory]) {
				if (c === undefined || c === 0) break
				name += String.fromCharCode(c)
			}
			if (this.masterMemoryNames[memory] !== name) {
				this.masterMemoryNames[memory] = name
				this.actions() // rebuild action definitions, e.g. the master memory dropdown label
			}
		} else if (line.match(/LBPMe\d+,\d+,\d+$/)) {
			//One character (as ASCII code) of a regular preset memory's name, 16 chars max, NUL-terminated if shorter
			const [memory, charIndex, code] = line.replace('LBPMe', '').split(',').map(Number)
			this.presetMemoryNameChars[memory][charIndex] = code
			let name = ''
			for (const c of this.presetMemoryNameChars[memory]) {
				if (c === undefined || c === 0) break
				name += String.fromCharCode(c)
			}
			if (this.presetMemoryNames[memory] !== name) {
				this.presetMemoryNames[memory] = name
				this.actions() // rebuild action definitions, e.g. the memory dropdown label
			}
		} else if (line.match(/CMlab\d+,\d+,\d+$/)) {
			//One character (as ASCII code) of a confidence memory's name, 16 chars max, NUL-terminated if shorter
			const [memory, charIndex, code] = line.replace('CMlab', '').split(',').map(Number)
			this.confidenceMemoryNameChars[memory][charIndex] = code
			let name = ''
			for (const c of this.confidenceMemoryNameChars[memory]) {
				if (c === undefined || c === 0) break
				name += String.fromCharCode(c)
			}
			if (this.confidenceMemoryNames[memory] !== name) {
				this.confidenceMemoryNames[memory] = name
				this.actions() // rebuild action definitions, e.g. the confidence memory dropdown label
			}
		} else if (line.match(/LBMMo\d+,\d+,\d+$/)) {
			//One character (as ASCII code) of a monitoring memory's name, 16 chars max, NUL-terminated if shorter
			const [memory, charIndex, code] = line.replace('LBMMo', '').split(',').map(Number)
			this.monitoringMemoryNameChars[memory][charIndex] = code
			let name = ''
			for (const c of this.monitoringMemoryNameChars[memory]) {
				if (c === undefined || c === 0) break
				name += String.fromCharCode(c)
			}
			if (this.monitoringMemoryNames[memory] !== name) {
				this.monitoringMemoryNames[memory] = name
				this.actions() // rebuild action definitions, e.g. the monitoring memory dropdown label
			}
		}
	}

	//(Re)declares the per-screen variables for only the screens that are currently enabled (SPise).
	updateVariableDefinitions() {
		let definitions = {
			'device.firmware': { name: 'Device firmware version' },
			'device.controllers': { name: 'Number of connected controllers' },
			'device.fan_alarm': { name: 'Device fan alarm (1 = alarm raised)' },
			'device.temperature_alarm': { name: 'Device temperature alarm status' },
			'device.ready': { name: 'Device ready status' },
		}
		// screenKnownToExist (sticky, never reset once true) rather than the live screenEnabled:
		// a screen switched to confidence mode reports as disabled (SPise = "has outputs and not
		// confidence"), which would otherwise make its variables - including isconfidence itself -
		// disappear right when they'd become interesting.
		this.screenKnownToExist.forEach((known, s) => {
			if (!known) return
			definitions[`S${s + 1}.t-bar`] = { name: `Screen ${s + 1} T-Bar position` }
			definitions[`S${s + 1}.name`] = { name: `Screen ${s + 1} name` }
			definitions[`S${s + 1}.prv.memory`] = { name: `Screen ${s + 1} memory in preview` }
			definitions[`S${s + 1}.pgm.memory`] = { name: `Screen ${s + 1} memory in program` }
			definitions[`S${s + 1}.globaltake`] = { name: `Screen ${s + 1} selected for global take` }
			definitions[`S${s + 1}.width`] = { name: `Screen ${s + 1} width in pixels (excludes AOI)` }
			definitions[`S${s + 1}.height`] = { name: `Screen ${s + 1} height in pixels (excludes AOI)` }
			definitions[`S${s + 1}.isconfidence`] = { name: `Screen ${s + 1} is a confidence screen` }
		})
		this.outputAvailable.forEach((available, o) => {
			if (!available) return
			definitions[`Out${o + 1}.name`] = { name: `Output ${o + 1} name` }
			definitions[`Out${o + 1}.active`] = { name: `Output ${o + 1} is active` }
			definitions[`Out${o + 1}.hdcp`] = { name: `Output ${o + 1} HDCP status` }
		})
		this.setVariableDefinitions(definitions)
	}

	//Dropdown choices for the screens that currently exist (SPise), labelled with their name if known.
	//Pass oneBased:true for options whose stored values are 1-8 (e.g. destination screen fields),
	//or leave false for options whose stored values are the 0-based screen index (e.g. SPscl/SPCtk).
	getScreenChoices(oneBased = false) {
		return this.screenEnabled
			.map((enabled, s) => {
				if (!enabled) return undefined
				const label = `S${s + 1}` + (this.screenNames[s] ? ` - ${this.screenNames[s]}` : '')
				return { id: String(oneBased ? s + 1 : s), label }
			})
			.filter((choice) => choice !== undefined)
	}

	//Dropdown choices for the inputs that currently exist (INava): 1-12 without a linked slave
	//device, 1-24 with. Stored option values are always 1-based, matching the existing convention.
	getInputChoices() {
		return this.inputAvailable
			.map((available, i) => {
				if (!available) return undefined
				const plug = PLUG_NAMES[this.inputActivePlug[i]]
				const parts = [String(i + 1), plug, this.inputNames[i]].filter((part) => !!part)
				return { id: String(i + 1), label: parts.join(' - ') }
			})
			.filter((choice) => choice !== undefined)
	}

	//Derives which memory is currently in program/preview per screen from the raw
	//per-buffer memory identity (memoriesBuf0/1) and the take/t-bar status (programBuffer).
	updatePresetMemories() {
		let variableValues = {}
		for (let screen = 0; screen < 8; screen += 1) {
			if (this.programBuffer[screen] === 0) {
				this.memoriesPGM[screen] = this.memoriesBuf0[screen]
				this.memoriesPVW[screen] = this.memoriesBuf1[screen]
			} else {
				this.memoriesPGM[screen] = this.memoriesBuf1[screen]
				this.memoriesPVW[screen] = this.memoriesBuf0[screen]
			}
			variableValues[`S${screen + 1}.pgm.memory`] = this.memoriesPGM[screen] === 255 ? '' : this.memoriesPGM[screen] + 1
			variableValues[`S${screen + 1}.prv.memory`] = this.memoriesPVW[screen] === 255 ? '' : this.memoriesPVW[screen] + 1
		}
		this.setVariableValues(variableValues)
		this.checkFeedbacks('memory_active')
	}

	init_tcp() {
		let self = this
		let receivebuffer = ''

		if (self.socket !== undefined) {
			self.socket.destroy()
		}

		if (self.config?.host) {
			// Hardcoded: the documented TPP port (10600) doesn't broadcast enough (e.g. no live
			// t-bar position, see GCtba), so this module needs the richer internal port.
			self.socket = new TCPHelper(self.config.host, 10500)

			self.socket.on('status_change', function (status, message) {
				self.updateStatus(status, message)
			})

			self.socket.on('error', (err) => {
				self.log('debug', 'Network error ' + err)
				self.log('error', 'Network error: ' + err.message)
			})

			self.socket.on('connect', () => {
				self.log('debug', 'Connected')
				self.sendcmd('')
			})

			// separate buffered stream into lines with responses
			self.socket.on('data', (chunk) => {
				let i = 0,
					line = '',
					offset = 0
				receivebuffer += chunk
				while ((i = receivebuffer.indexOf('\r\n', offset)) !== -1) {
					line = receivebuffer.substring(offset, i)
					offset = i + 2
					self._receiveline(line.toString())
				}
				receivebuffer = receivebuffer.substring(offset)
			})
		}
	}

	// Return config fields for web config
	getConfigFields() {
		let self = this

		return [
			{
				type: 'textinput',
				id: 'host',
				label: 'IP-Adress of Livecore Unit',
				width: 6,
				default: '192.168.2.140',
				regex: Regex.IP,
				tooltip:
					'Enter the IP-adress of the Livecore unit you want to control. The IP of the unit can be found on the frontpanel LCD.\nIf you want to control stacked configurations, please enter the IP of the master unit.',
			},
			{
				type: 'static-text',
				id: 'detected-device',
				label: 'Detected device',
				value: self.modelname
					? self.modelname + (self.isSimulator ? ' (Simulator)' : '')
					: 'Not yet detected - save the config with a valid IP-Adress and reopen this dialog once connected.',
			},
		]
	}

	// When module gets deleted
	destroy() {
		let self = this

		if (self.socket !== undefined) {
			self.socket.destroy()
		}

		self.log('debug', 'destroy ' + self.id)
	}

	actions() {
		let self = this
		self.setActionDefinitions({
			/*
						Note: For self generating commands use option ids 0,1,...,5 and 'value'.
						The command will be of the form [valueof0],[valueof1],...[valueof5],[valueofvalue][CommandID]
						for set-commands you need a value, for get-commands you mustn't have a value
						for simple commands the value can be hardcoded in the CommandID, like "1SPtsl".
					*/
			'1SPtsl': {
				name: 'Take selected screens (Global take)',
				options: [],
				callback: this.actioncb,
			},
			takescreen: {
				name: 'Take single screen',
				options: [
					{
						type: 'dropdown',
						label: 'Screen',
						id: 'screen',
						default: '0',
						choices: self.getScreenChoices(),
					},
				],
				callback: (action) => {
					let cmd = '' + action.options.screen + ',1SPCtk'
					self.sendcmd(cmd)
				},
			},

			loadpreset: {
				name: 'Load Memory',
				options: [
					{
						type: 'dropdown',
						label: 'Memory to load',
						id: 'memory',
						default: '1',
						choices: self.presetMemoryNames.map((name, m) => ({
							id: String(m + 1),
							label: `${m + 1}` + (name ? ` - ${name}` : ''),
						})),
					},
					{
						type: 'dropdown',
						label: 'Destination screen',
						id: 'destscreen',
						default: '1',
						choices: self.getScreenChoices(true),
					},
					{
						type: 'dropdown',
						label: 'PGM/PVW',
						id: 'pgmpvw',
						default: '1',
						tooltip: 'Select wether the memory schould be loaded into the preview or program of the screen',
						choices: [
							{ id: '0', label: 'Program' },
							{ id: '1', label: 'Preview' },
						],
					},
					{
						type: 'dropdown',
						label: 'Scale enable',
						id: 'scale',
						default: '1',
						tooltip:
							'Select wether the layers in the memory should be scaled according to the size of the screen if it is different from the size of the screen which the memory has been saved from.',
						choices: [
							{ id: '0', label: 'Do not scale' },
							{ id: '1', label: 'Enable scale' },
						],
					},
				],
				callback: (action) => {
					let cmd = ''
					// set scale
					if (action.options.scale == '0') {
						cmd = '0PMlse\n'
					} else {
						cmd = '1PMlse\n'
					}

					// set memory to load
					cmd += '' + (parseInt(action.options.memory) - 1) + 'PMmet\n'

					// set destination screen
					cmd += '' + (parseInt(action.options.destscreen) - 1) + 'PMscf\n'

					// set preview/program
					if (action.options.pgmpvw == '0') {
						cmd += '0PMprf\n'
					} else {
						cmd += '1PMprf\n'
					}

					// do the load
					cmd += '1PMloa' //last line break is added in sendcmd
					self.sendcmd(cmd)
				},
			},
			loadmaster: {
				name: 'Load Master Memory',
				options: [
					{
						type: 'dropdown',
						label: 'Master Memory to load',
						id: 'memory',
						default: '1',
						tooltip: 'Only master memories that actually have something saved to them are listed.',
						choices: self.masterMemoryValid
							.map((valid, m) =>
								valid
									? { id: String(m + 1), label: `${m + 1}` + (self.masterMemoryNames[m] ? ` - ${self.masterMemoryNames[m]}` : '') }
									: undefined
							)
							.filter((choice) => choice !== undefined),
					},
					{
						type: 'dropdown',
						label: 'PGM/PVW',
						id: 'pgmpvw',
						default: '1',
						tooltip: 'Select wether the memory schould be loaded into the preview or program of the screens',
						choices: [
							{ id: '0', label: 'Program' },
							{ id: '1', label: 'Preview' },
						],
					},
					{
						type: 'dropdown',
						label: 'Scale enable',
						id: 'scale',
						default: '1',
						tooltip:
							'Select wether the layers in the memory should be scaled according to the size of the screens if it is different from the size of the screens which the memory has been saved from.',
						choices: [
							{ id: '0', label: 'Do not scale' },
							{ id: '1', label: 'Enable scale' },
						],
					},
				],
				callback: (action) => {
					let cmd = ''
					// set scale
					if (action.options.scale == '0') {
						cmd += '0PMlse\n'
					} else {
						cmd += '1PMlse\n'
					}

					// set memory to load
					cmd += parseInt(action.options.memory) - 1 + 'PSmet\n'

					// set preview/program
					if (action.options.pgmpvw == '0') {
						cmd += '0PSprf\n'
					} else {
						cmd += '1PSprf\n'
					}

					// do the load
					cmd += '1PSloa' //last line break is added in sendcmd
					self.sendcmd(cmd)
				},
			},
			setfilter: {
				name: 'Set recall filter',
				options: [
					{
						type: 'dropdown',
						label: 'Layer source',
						id: 'filter1',
						default: '1',
						tooltip: 'Select wether the layer source should be included in the memory recall.',
						choices: [
							{ id: '0', label: 'Exclude source' },
							{ id: '1', label: 'Include source' },
						],
					},
					{
						type: 'dropdown',
						label: 'Layer position and size',
						id: 'filter2',
						default: '1',
						tooltip: 'Select wether the layer position and size should be included in the memory recall.',
						choices: [
							{ id: '0', label: 'Exclude position and size' },
							{ id: '1', label: 'Include position and size' },
						],
					},
					{
						type: 'dropdown',
						label: 'Layer transparency',
						id: 'filter4',
						default: '1',
						tooltip: 'Select wether the layer transparency should be included in the memory recall.',
						choices: [
							{ id: '0', label: 'Exclude transparency' },
							{ id: '1', label: 'Include transparency' },
						],
					},
					{
						type: 'dropdown',
						label: 'Layer crop',
						id: 'filter8',
						default: '1',
						tooltip: 'Select wether the layer crop should be included in the memory recall.',
						choices: [
							{ id: '0', label: 'Exclude crop' },
							{ id: '1', label: 'Include crop' },
						],
					},
					{
						type: 'dropdown',
						label: 'Layer border',
						id: 'filter16',
						default: '1',
						tooltip: 'Select wether the layer border apperance should be included in the memory recall.',
						choices: [
							{ id: '0', label: 'Exclude border' },
							{ id: '1', label: 'Include border' },
						],
					},
					{
						type: 'dropdown',
						label: 'Layer transitions',
						id: 'filter32',
						default: '1',
						tooltip: 'Select wether the layer opening and closing transitions should be included in the memory recall.',
						choices: [
							{ id: '0', label: 'Exclude transitions' },
							{ id: '1', label: 'Include transitions' },
						],
					},
					{
						type: 'dropdown',
						label: 'Layer effects',
						id: 'filter64',
						default: '1',
						tooltip: 'Select wether the layer effects should be included in the memory recall.',
						choices: [
							{ id: '0', label: 'Exclude effects' },
							{ id: '1', label: 'Include effects' },
						],
					},
					{
						type: 'dropdown',
						label: 'Layer timing',
						id: 'filter128',
						default: '1',
						tooltip: 'Select wether the layer timing should be included in the memory recall.',
						choices: [
							{ id: '0', label: 'Exclude timing' },
							{ id: '1', label: 'Include timing' },
						],
					},
					{
						type: 'dropdown',
						label: 'Layer speed',
						id: 'filter256',
						default: '1',
						tooltip: 'Select wether the layer speed should be included in the memory recall.',
						choices: [
							{ id: '0', label: 'Exclude speed' },
							{ id: '1', label: 'Include speed' },
						],
					},
					{
						type: 'dropdown',
						label: 'Layer flying curve',
						id: 'filter512',
						default: '1',
						tooltip: 'Select wether the layer flying curve should be included in the memory recall.',
						choices: [
							{ id: '0', label: 'Exclude flying curve' },
							{ id: '1', label: 'Include flying curve' },
						],
					},
					{
						type: 'dropdown',
						label: 'Native background',
						id: 'filter1024',
						default: '1',
						tooltip: 'Select wether the native background should be included in the memory recall.',
						choices: [
							{ id: '0', label: 'Exclude native background' },
							{ id: '1', label: 'Include native background' },
						],
					},
					{
						type: 'dropdown',
						label: 'Layer mask',
						id: 'filter2048',
						default: '1',
						tooltip: 'Select wether the layer mask should be included in the memory recall.',
						choices: [
							{ id: '0', label: 'Exclude mask' },
							{ id: '1', label: 'Include mask' },
						],
					},
				],
				callback: (action) => {
					let filterval = 0
					if (action.options.filter1 === '1') filterval += 1
					if (action.options.filter2 === '1') filterval += 2
					if (action.options.filter4 === '1') filterval += 4
					if (action.options.filter8 === '1') filterval += 8
					if (action.options.filter16 === '1') filterval += 16
					if (action.options.filter32 === '1') filterval += 32
					if (action.options.filter64 === '1') filterval += 64
					if (action.options.filter128 === '1') filterval += 128
					if (action.options.filter256 === '1') filterval += 256
					if (action.options.filter512 === '1') filterval += 512
					if (action.options.filter1024 === '1') filterval += 1024
					if (action.options.filter2048 === '1') filterval += 2048
					let cmd = filterval.toString() + 'PMcat'
					self.sendcmd(cmd)
				},
			},
			inputfreeze: {
				name: 'Freeze Input',
				options: [
					{
						type: 'dropdown',
						label: 'Input',
						id: 'input',
						default: '1',
						choices: self.getInputChoices(),
					},
					{
						type: 'dropdown',
						label: 'Freeze Status',
						id: 'freeze',
						default: '0',
						tooltip: 'Select wether the input should be frozen or live.',
						choices: [
							{ id: '0', label: 'Unfrozen' },
							{ id: '1', label: 'Frozen' },
						],
					},
				],
				callback: (action) => {
					// set input
					let cmd = '' + (parseInt(action.options.input) - 1) + ','
					// freeze?
					cmd += action.options.freeze + 'INfrz'
					self.sendcmd(cmd)
				},
			},
			loadmonitoring: {
				name: 'Recall Monitoring Memory',
				options: [
					{
						type: 'dropdown',
						label: 'Monitoring Memory to load',
						id: 'memory',
						default: '1',
						choices: self.monitoringMemoryNames.map((name, m) => ({
							id: String(m + 1),
							label: `${m + 1}` + (name ? ` - ${name}` : ''),
						})),
					},
					{
						type: 'dropdown',
						label: 'Device',
						id: 'device',
						default: '0',
						tooltip:
							'Select wether the monitoring memory schould be recalled on master or slave device in a stacked configuration. Leave at master for single configuration.',
						choices: [
							{ id: '0', label: 'Master' },
							{ id: '1', label: 'Slave' },
						],
					},
				],
				callback: (action) => {
					let cmd = `${parseInt(action.options.memory) - 1},`

					// set device
					if (action.options.device === '1') {
						cmd += '1,'
					} else {
						cmd += '0,'
					}

					// do the load
					cmd += '1MMloa' //last line break is added in sendcmd
					self.sendcmd(cmd)
				},
			},
			monitoringfullscreen: {
				name: 'Fullscreen Monitoring',
				options: [
					{
						type: 'textinput',
						label: 'Source to show',
						id: 'input',
						default: '1',
						tooltip:
							'Enter the number of the source you want to show. 1 to 12 for inputs of master device, 13 to 24 for inputs of slave device, 25 to 40 for frames and logos of master and slave, 41 to 48 for screen 1 to 8 and 49 to 56 for preview 1 to 8.',
						regex: '/^0*([1-9]|[1-4][0-9]|5[0-6])$/',
					},
					{
						type: 'dropdown',
						label: 'Device',
						id: 'device',
						default: '0',
						tooltip: 'Select wether to switch the master or the slave device in stacked configuration.',
						choices: [
							{ id: '0', label: 'Master' },
							{ id: '1', label: 'Slave' },
						],
					},
					{
						type: 'dropdown',
						label: 'Fullscreen Status',
						id: 'fullscreen',
						default: '0',
						tooltip: 'Select wether the monitoring output should be in mosaic mode or fullscreen mode.',
						choices: [
							{ id: '0', label: 'Mosaic mode' },
							{ id: '1', label: 'Fullscreen Mode' },
						],
					},
				],
				callback: (action) => {
					let cmd = ''
					if (action.options.fullscreen == 1) {
						// select input
						cmd = '' + action.options.device + ',' + (parseInt(action.options.input) - 1) + 'MLfes\n'
						// activate fullscreen
						cmd += '' + action.options.device + ',1MLfen\n'
					} else {
						// deactivate fullscreen
						cmd = '' + action.options.device + ',0MLfen\n'
					}
					cmd += '' + action.options.device + ',0MLupd\n' + action.options.device + ',1MLupd'
					self.sendcmd(cmd)
				},
			},
			selectscreens: {
				name: 'Select screens for global take',
				tooltip:
					'Select the screens which schould transition with the global take command. The selection stays active until changed again.',
				options: self.screenEnabled
					.map((enabled, s) =>
						enabled
							? {
									type: 'dropdown',
									label: `Screen ${s + 1}` + (self.screenNames[s] ? ` - ${self.screenNames[s]}` : ''),
									id: String(s),
									default: '0',
									choices: [
										{ id: '0', label: 'No change' },
										{ id: '1', label: 'Add to selection' },
										{ id: '2', label: 'Remove from selection' },
										{ id: '3', label: 'Toggle selection' },
									],
								}
							: undefined
					)
					.filter((option) => option !== undefined),
				callback: (action) => {
					let cmd = ''
					for (let option in action.options) {
						if (action.options[option] == '1') {
							cmd += option + ',1SPscl\n'
						} else if (action.options[option] == '2') {
							cmd += option + ',0SPscl\n'
						} else if (action.options[option] == '3') {
							cmd += option + ',' + (self.activeScreen[Number(option)] ? '0' : '1') + 'SPscl\n'
						}
					}

					if (cmd == '') {
						return
					} else {
						cmd = cmd.trim()
					}
					self.sendcmd(cmd)
				},
			},
			selectscreen: {
				name: 'Select single screen for global take',
				tooltip:
					'Add, remove or toggle a single screen in the selection which schould transition with the global take command. The selection stays active until changed again.',
				options: [
					{
						type: 'dropdown',
						label: 'Screen',
						id: 'screen',
						default: '0',
						choices: self.getScreenChoices(),
					},
					{
						type: 'dropdown',
						label: 'Action',
						id: 'action',
						default: '1',
						choices: [
							{ id: '1', label: 'Add to selection' },
							{ id: '2', label: 'Remove from selection' },
							{ id: '3', label: 'Toggle selection' },
						],
					},
				],
				callback: (action) => {
					const screen = action.options.screen
					let value
					if (action.options.action == '1') {
						value = '1'
					} else if (action.options.action == '2') {
						value = '0'
					} else {
						value = self.activeScreen[Number(screen)] ? '0' : '1'
					}
					self.sendcmd(screen + ',' + value + 'SPscl')
				},
			},
			loadconfidence: {
				name: 'Load confidence Memory',
				options: [
					{
						type: 'dropdown',
						label: 'Memory',
						id: 'memory',
						default: '1',
						choices: self.confidenceMemoryNames.map((name, m) => ({
							id: String(m + 1),
							label: `${m + 1}` + (name ? ` - ${name}` : ''),
						})),
					},
					{
						type: 'dropdown',
						label: 'Destination screen',
						id: 'destscreen',
						default: '1',
						choices: self.getScreenChoices(true),
					},
				],
				callback: (action) => {
					//         set memory to load                   set destination screen
					let cmd = `${parseInt(action.options.memory) - 1},${parseInt(action.options.destscreen) - 1},1CMloa`
					self.sendcmd(cmd)
				},
			},
			activateconfidence: {
				name: 'Switch confidence mode',
				options: [
					{
						type: 'dropdown',
						label: 'Screen',
						id: 'destscreen',
						default: '1',
						// Not self.getScreenChoices(): SPise (and thus screenEnabled) is defined as
						// "has outputs and not confidence", so a screen currently in confidence mode
						// would disappear from that list - making it impossible to switch back off.
						// This action needs to be able to target a screen either way, so it always
						// lists all 8 possible screens instead.
						choices: Array.from({ length: 8 }, (_, s) => ({ id: String(s + 1), label: `S${s + 1}` })),
					},
					{
						type: 'dropdown',
						label: 'Mode',
						id: 'mode',
						default: '0',
						tooltip: 'Select wether confidence mode should be switched on or off at selected screen',
						choices: [
							{ id: '0', label: 'Off' },
							{ id: '1', label: 'On' },
						],
					},
				],
				callback: (action) => {
					//         set memory to load                   set mode
					let cmd = `${parseInt(action.options.destscreen) - 1},${action.options.mode}SCico`
					self.sendcmd(cmd)
				},
			},
			switchplug: {
				name: 'Switch input plug',
				tooltip:
					'Note that not all inputs may be available at your system and not all plugs are available at any input.',
				options: [
					{
						type: 'dropdown',
						label: 'Input',
						id: 'input',
						default: '1',
						choices: self.getInputChoices(),
					},
					{
						type: 'dropdown',
						label: 'Plug',
						id: 'plug',
						default: '0',
						tooltip: 'Select the plug to use for that input',
						choices: [
							{ id: '0', label: 'Analog VGA connector' },
							{ id: '1', label: 'Analog DVI-A connector' },
							{ id: '2', label: 'DVI' },
							{ id: '3', label: 'SDI' },
							{ id: '4', label: 'HDMI' },
							{ id: '5', label: 'DisplayPort' },
						],
					},
					// One info text per input, always shown (filtering to just the selected input would
					// require disableAutoExpression on the "input" field above, which would prevent it
					// from being used as an expression - keeping "input" expression-capable wins here).
					...self.getInputChoices().map((choice) => ({
						type: 'static-text',
						id: `plugs_info_${choice.id}`,
						label: `Plugs on input ${choice.id}`,
						value:
							'Available Input Plugs: ' +
							(self.inputPlugAvailable[Number(choice.id) - 1]
								.map((available, p) => (available ? PLUG_NAMES[p] : undefined))
								.filter((name) => name !== undefined)
								.join(', ') || 'unknown'),
						disableAutoExpression: true,
					})),
				],
				callback: (action) => {
					// set input
					let cmd = '' + (parseInt(action.options.input) - 1) + ','
					// set plug
					cmd += action.options.plug + 'INplg'
					self.sendcmd(cmd)
				},
			},
			sendcustomcommand: {
				name: 'Send custom command',
				options: [
					{
						type: 'textinput',
						label: 'Command',
						id: 'command',
						useVariables: true,
						default: '',
						tooltip:
							"Enter any command you like in plain ASCII. Beware of correct syntax, you mustn't enter the linebreak at the end of the command. You can use variables here.",
					},
				],
				callback: (action) => {
					// With useVariables:true, Companion resolves variables in the value before
					// the callback runs, so action.options.command already contains the final command.
					self.sendcmd(action.options.command)
				},
			},
		})
	}
}
