#!/usr/bin/env bun

const ARRAY_EMPTY = [];

function create_vscode_extension_client(port = 3579, host = 'localhost') {
	let ws = null;
	let connected = false;
	let connecting = false
	
	const pending_commands = new Map();
	let command_id_counter = 0;
	
	const event_listeners = new Map();
	const ns_event_listeners = new Map();
	
	const url = `ws://${host}:${port}`;
	const generate_command_id = () => `cmd_${++command_id_counter}_${Date.now()}`;
	
	const connect = () => {
		if (connecting || connected) return Promise.resolve();
		
		connecting = true;
		
		return new Promise((resolve, reject) => {
			try {
				ws = new WebSocket(url);
				
				ws.onopen = () => {
					connected = true;
					connecting = false;
					resolve();
				};
				
				ws.onmessage = (event) => {
					try {
						const message = JSON.parse(event.data);
						handle_message(message);
					} catch (error) {
						console.warn('VDB: Failed to parse message:', error.message);
					}
				};
				
				ws.onclose = (event) => {
					connected = false;
					connecting = false;
					
					for (const [id, { reject }] of pending_commands) {
						reject(new Error('Connection closed'));
					}
					pending_commands.clear();
				};
				
				ws.onerror = (error) => {
					connecting = false;
					if (!connected) {
						reject(new Error(`Failed to connect to WebSocket at ${url}`));
					}
				};
				
			} catch (error) {
				connecting = false;
				reject(error);
			}
		});
	};
	
	const handle_message = (message) => {
		if (message.type === 'event') {
			emit_event(message.event, message.data);
		} else if (message.id) {
			const pending = pending_commands.get(message.id);
			if (pending) {
				pending_commands.delete(message.id);
				if (message.success) {
					pending.resolve(message.data);
				} else {
					pending.reject(new Error(message.error || 'Command failed'));
				}
			}
		}
	};
	
	const emit_event = (event, data) => {
		const listeners = event_listeners.get(event) || ARRAY_EMPTY;

		for (const callback of listeners) {
			try {
				callback(data);
			} catch (error) {
				console.warn(`VDB: Event listener error for '${event}':`, error.message);
			}
		}

		const [event_ns, event_name] = event.split(':');
		const ns_listeners = ns_event_listeners.get(event_ns) || ARRAY_EMPTY;

		for (const callback of ns_listeners) {
			try {
				callback(event_name, data);
			} catch (error) {
				console.warn(`VDB: Namespace listener error for '${event_ns}' on event '${event}':`, error.message);
			}
		}
	};
	
	const send_command = async (command, data = {}, timeout = 10000) => {
		if (!connected)
			await connect();
		
		return new Promise((resolve, reject) => {
			const id = generate_command_id();
			const message = {
				id,
				command,
				data
			};
			
			const timeout_id = setTimeout(() => {
				pending_commands.delete(id);
				reject(new Error(`Command '${command}' timed out after ${timeout}ms`));
			}, timeout);
			
			pending_commands.set(id, {
				resolve: (data) => {
					clearTimeout(timeout_id);
					resolve(data);
				},
				reject: (error) => {
					clearTimeout(timeout_id);
					reject(error);
				}
			});
			
			try {
				ws.send(JSON.stringify(message));
			} catch (error) {
				clearTimeout(timeout_id);
				pending_commands.delete(id);
				reject(new Error(`Failed to send command: ${error.message}`));
			}
		});
	};
	
	const client = {
		url,
		
		async connect() {
			return await connect();
		},
		
		disconnect() {
			if (ws) {
				ws.close(1000); // Clean close
				ws = null;
			}
			connected = false;
			connecting = false;
		},
		
		get connected() {
			return connected;
		},
		
		on(event, callback) {
			if (typeof callback !== 'function')
				throw new Error('Callback must be a function');
			
			if (!event_listeners.has(event))
				event_listeners.set(event, []);
			
			event_listeners.get(event).push(callback);
		},
		
		off(event, callback = null) {
			if (!event_listeners.has(event))
				return;
			
			if (callback === null) {
				event_listeners.delete(event);
			} else {
				const listeners = event_listeners.get(event);
				const index = listeners.indexOf(callback);
				if (index !== -1) {
					listeners.splice(index, 1);
					if (listeners.length === 0)
						event_listeners.delete(event);
				}
			}
		},
		
		on_namespace(namespace, callback) {
			if (typeof callback !== 'function')
				throw new Error('Callback must be a function');
			
			if (typeof namespace !== 'string' || namespace.length === 0)
				throw new Error('Namespace must be a non-empty string');
		
			if (!ns_event_listeners.has(namespace))
				ns_event_listeners.set(namespace, []);

			ns_event_listeners.get(namespace).push(callback);
		},
		
		off_namespace(namespace, callback = null) {
			if (!ns_event_listeners.has(namespace))
				return;

			if (callback === null) {
				// clear the whole namespace
				ns_event_listeners.delete(namespace);
			} else {
				// only clear the one specific callback
				const listeners = ns_event_listeners.get(namespace);
				const index = listeners.indexOf(callback);

				if (index !== -1) {
					listeners.splice(index, 1);

					// no more listeners, get rid of the array
					if (listeners.length === 0)
						ns_event_listeners.delete(namespace);
				}
			}
		},
		
		async is_available() {
			try {
				await this.get_status();
				return true;
			} catch (error) {
				return false;
			}
		},
		
		async get_status() {
			return await send_command('status');
		},
		
		async get_variables() {
			return await send_command('variables');
		},
		
		async get_variable(name) {
			return await send_command('variables', { name });
		},
		
		async get_call_stack() {
			const result = await send_command('callstack');
			return result;
		},
		
		async get_threads() {
			return await send_command('threads');
		},
		
		async get_registers() {
			return await send_command('registers');
		},
		
		async evaluate_expression(expression, frame_id = null, context = 'watch') {
			return await send_command('evaluate', { 
					expression, 
					frameId: frame_id, 
					context 
				});
		},
		
		async read_memory(address, count = 64, offset = 0) {
			return await send_command('memory', { address, count, offset });
		},
		
		async set_breakpoints(file, lines, condition = null) {
			const data = { file, lines, action: 'set' };
			if (condition)
				data.condition = condition;
			
			return await send_command('breakpoints', data);
		},
		
		async clear_breakpoints(file, lines = null) {
			return await send_command('breakpoints', { file, lines, action: 'clear' });
		},
		
		async continue(thread_id = null) {
			return await send_command('control', { action: 'continue', threadId: thread_id });
		},
		
		async step_over(thread_id = null) {
			return await send_command('control', { action: 'stepOver', threadId: thread_id });
		},
		
		async step_in(thread_id = null) {
			return await send_command('control', { action: 'stepIn', threadId: thread_id });
		},
		
		async step_out(thread_id = null) {
			return await send_command('control', { action: 'stepOut', threadId: thread_id });
		},
		
		async pause(thread_id = null) {
			return await send_command('control', { action: 'pause', threadId: thread_id });
		},
		
		async control(action, thread_id = null) {
			return await send_command('control', { action, threadId: thread_id });
		},
		
		async get_profiles() {
			return await send_command('profiles');
		},
		
		async start_debugging(profile_name = null) {
			return await send_command('start', { profile: profile_name });
		},
		
		async get_all_breakpoints() {
			return await send_command('breakpoints');
		},
		
		async add_breakpoints(file, lines, condition = null) {
			return await this.set_breakpoints(file, lines, condition);
		},
		
		async remove_breakpoints(file, lines = null) {
			return await this.clear_breakpoints(file, lines);
		},
		
		async disassemble(address = null, count = 10, offset = 0) {
			return await send_command('disassemble', { address, count, offset });
		},
		
		async wait_for_event(events, timeout = 60000) {
			if (typeof events === 'string')
				events = [events];
			
			return new Promise((resolve, reject) => {
				const timeout_id = setTimeout(() => {
					events.forEach(event => client.off(event, event_handlers.get(event)));
					reject(new Error(`Timeout waiting for events: ${events.join(', ')}`));
				}, timeout);
				
				const event_handlers = new Map();
				
				events.forEach(event => {
					const handler = (data) => {
						clearTimeout(timeout_id);
						events.forEach(e => client.off(e, event_handlers.get(e)));
						resolve({ event, data });
					};
					event_handlers.set(event, handler);
					client.on(event, handler);
				});
			});
		}
	};
	
	return client;
}

function format_hex_dump(buffer, start_address = '0x0') {
	if (!buffer || buffer.length === 0)
		return 'No data';
	
	let result = '';
	const bytes_per_line = 16;
	
	for (let i = 0; i < buffer.length; i += bytes_per_line) {
		let addr = start_address;
		if (typeof start_address === 'string' && start_address.startsWith('0x'))
			addr = `0x${(parseInt(start_address, 16) + i).toString(16).padStart(8, '0').toUpperCase()}`;
		else
			addr = `${start_address}+${i}`;
		
		result += `  ${addr}: `;
		
		const line_bytes = buffer.slice(i, Math.min(i + bytes_per_line, buffer.length));
		const hex_part = Array.from(line_bytes)
			.map(b => b.toString(16).padStart(2, '0').toUpperCase())
			.join(' ');
		
		result += hex_part.padEnd(bytes_per_line * 3 - 1, ' ');
		
		result += ' |';
		const ascii_part = Array.from(line_bytes)
			.map(b => (b >= 32 && b <= 126) ? String.fromCharCode(b) : '.')
			.join('');
		result += ascii_part.padEnd(bytes_per_line, ' ');
		result += '|\n';
	}
	
	return result;
}

function format_registers(registers) {
	let result = '';
	
	for (const [category, data] of Object.entries(registers)) {
		if (typeof data === 'object' && data !== null && !data.value) {
			result += `${category}:\n`;
			result += format_register_category(data);
			result += '\n';
		}
	}
	
	return result.trim();
}

function format_register_category(category_data) {
	const registers = [];
	
	for (const [name, data] of Object.entries(category_data)) {
		if (typeof data === 'object' && data !== null) {
			if (data.value !== undefined) {
				registers.push({ name, value: data.value, type: data.type });
			} else {
				for (const [nested_name, nested_data] of Object.entries(data)) {
					if (typeof nested_data === 'object' && nested_data.value !== undefined)
						registers.push({ name: nested_name, value: nested_data.value, type: nested_data.type });
				}
			}
		}
	}
	
	if (registers.length === 0)
		return '';
	
	const has_long_values = registers.some(reg => reg.value && reg.value.length > 20);
	
	if (has_long_values) {
		return registers.map(reg => `  ${reg.name}=${reg.value}`).join('\n') + '\n';
	} else {
		const registers_per_line = 3;
		const max_name_length = Math.max(...registers.map(reg => reg.name.length));
		const lines = [];
		
		for (let i = 0; i < registers.length; i += registers_per_line) {
			const line_registers = registers.slice(i, i + registers_per_line);
			const formatted_line = line_registers.map(reg => {
				const padded_name = reg.name.padEnd(max_name_length);
				return `${padded_name}=${reg.value}`;
			}).join('  ');
			lines.push(`  ${formatted_line}`);
		}
		
		return lines.join('\n') + '\n';
	}
}

function format_disassembly(instructions) {
	if (!instructions || instructions.length === 0)
		return 'No disassembly data available';
	
	let result = '';
	
	for (const instr of instructions) {
		let line = '';
		
		if (instr.address) {
			line += instr.address.padEnd(18, ' ');
		} else {
			line += ''.padEnd(18, ' ');
		}
		
		if (instr.instructionBytes) {
			const bytes = instr.instructionBytes.split(' ').join(' ');
			line += bytes.padEnd(20, ' ');
		} else {
			line += ''.padEnd(20, ' ');
		}
		
		if (instr.instruction)
			line += instr.instruction;
		
		if (instr.symbol)
			line += `  <${instr.symbol}>`;
		
		result += line + '\n';
	}
	
	return result.trim();
}

function format_event(event_name, data) {
	let parts = [event_name];
	
	if (data && typeof data === 'object') {
		for (const [key, value] of Object.entries(data)) {
			if (value !== null && value !== undefined) {
				if (key === 'location' && typeof value === 'object') {
					if (value.file && value.line) {
						const filename = value.file.split(/[/\\]/).pop();
						parts.push(`file=${filename}:${value.line}`);
					}
					if (value.function)
						parts.push(`function=${value.function}`);
				} else if (key === 'threadId' && value !== null) {
					parts.push(`thread=${value}`);
				} else if (key === 'reason') {
					parts.push(`reason=${value}`);
				} else if (key === 'name') {
					parts.push(`name=${value}`);
				} else if (key === 'type') {
					parts.push(`type=${value}`);
				} else if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
					parts.push(`${key}=${value}`);
				}
			}
		}
	}
	
	return parts.join(' ');
}

function create_vscode_debug_bridge(port = 3579, host = 'localhost') {
	const bridge = {
		extension_client: create_vscode_extension_client(port, host),
		extension_available: false,
		
		async initialize() {
			try {
				await bridge.extension_client.connect();
				bridge.extension_available = bridge.extension_client.connected;
			} catch (error) {
				console.warn(`Failed to connect to VSCode extension: ${error.message}`);
				bridge.extension_available = false;
			}
			return bridge.extension_available;
		},
		
		async get_status_info() {
			const base_info = {
				available: false,
				extension_available: bridge.extension_available
			};
			
			if (bridge.extension_available) {
				try {
					const status = await bridge.extension_client.get_status();
					if (status.debug_session_active) {
						return {
							...base_info,
							available: true,
							session: {
								name: status.session_name,
								type: status.session_type,
								isRunning: status.is_running
							},
							execution: {
								state: status.execution_state,
								stop_reason: status.stop_reason,
								stop_location: status.stop_location,
								stopped_at_breakpoint: status.stopped_at_breakpoint
							}
						};
					}
				}
				catch (error) {
					console.warn('Extension error:', error.message);
				}
			}
			
			return base_info;
		},
		
		async get_variable_value(name) {
			if (!bridge.extension_available)
				throw new Error('Variable access requires VSCode Debug Bridge extension');
			
			const variable = await bridge.extension_client.get_variable(name);
			return variable.value;
		},
		
		async get_all_variables() {
			if (!bridge.extension_available)
				throw new Error('Variable access requires VSCode Debug Bridge extension');
			
			const result = await bridge.extension_client.get_variables();
			return result.variables;
		},
		
		async evaluate_expression(expression) {
			if (!bridge.extension_available)
				throw new Error('Expression evaluation requires VSCode Debug Bridge extension');
			
			const result = await bridge.extension_client.evaluate_expression(expression);
			return result;
		},
		
		async get_call_stack() {
			if (!bridge.extension_available)
				throw new Error('Call stack access requires VSCode Debug Bridge extension');
			
			const result = await bridge.extension_client.get_call_stack();
			return result;
		},
		
		async get_registers() {
			if (!bridge.extension_available)
				throw new Error('Register access requires VSCode Debug Bridge extension');
			
			const result = await bridge.extension_client.get_registers();
			return result.registers;
		}
	};
	
	return bridge;
}

function parse_args(args) {
	const parsed = {
		port: 3579,
		host: 'localhost',
		args: []
	};
	
	for (const arg of args) {
		if (arg.startsWith('--')) {
			const [key, value] = arg.substring(2).split('=');
			
			switch (key) {
				case 'port':
					parsed.port = parseInt(value);
					break;
				case 'host':
					parsed.host = value;
					break;
				default:
					console.log(`unrecognized flag ${key}`);
			}
		} else {
			parsed.args.push(arg);
		}
	}
	
	return parsed;
}

async function main() {
	const raw_args = process.argv.slice(2);
	const { port, host, args } = parse_args(raw_args);
	const command = args[0] || 'status';
	
	const vdb = create_vscode_debug_bridge(port, host);
	
	try {
		const extension_available = await vdb.initialize();
		
		if (!extension_available && command !== 'status') {
			console.error('extension not available - limited capabilities');
			return;
		}
		
		switch (command) {
			case 'wait':
				const user_events = args[1] ? args[1].split(',') : ['stopped'];
				const wait_events = user_events.map(event => event.trim().startsWith('dap:') ? event.trim() : `dap:${event.trim()}`);
				const timeout = args[2] ? parseInt(args[2]) * 1000 : 60000;
				
				console.log(`waiting for events: ${user_events.join(', ')} (timeout: ${timeout/1000}s)`);
				
				try {
					const result = await vdb.extension_client.wait_for_event(wait_events, timeout);
					const [event_ns, event_name] = result.event.split(':');
					const formatted = format_event(event_name, result.data);
					console.log(`event occurred: ${formatted}`);
				} catch (error) {
					console.error(error.message);
				}
				break;
				
			case 'events':
				console.log('monitoring debug events (press ctrl+c to stop)...');
				
				const event_handler = (event_name, data) => {
					const formatted = format_event(event_name, data);
					console.log(formatted);
				};
				
					vdb.extension_client.on_namespace('dap', event_handler);
				
				process.on('SIGINT', () => {
					console.log('aborted');
					vdb.extension_client.off_namespace('dap');
					process.exit(0);
				});
				
				await new Promise(() => {});
				break;
		
			case 'var':
				const var_name = args[1];
				if (!var_name) {
					console.error('variable name required');
					console.log('Usage: vdb var <name>');
					return;
				}
				
				try {
					const value = await vdb.get_variable_value(var_name);
					console.log(`${var_name}=${value}`);
				}
				catch (error) {
					console.error(error.message);
				}
				break;
				
			case 'vars':
				try {
					const variables = await vdb.get_all_variables();
					for (const [name, info] of Object.entries(variables)) {
						console.log(`${name}=${info.value} (${info.type})`);
					}
				}
				catch (error) {
					console.error(error.message);
				}
				break;
				
			case 'eval':
				const expression = args[1];
				if (!expression) {
					console.error('expression required');
					console.log('Usage: vdb eval <expression>');
					return;
				}
				
				try {
					const result = await vdb.evaluate_expression(expression);
					console.log(`${expression}=${result.value} (${result.type})`);
				}
				catch (error) {
					console.error(error.message);
				}
				break;
				
			case 'mem':
				const address = args[1];
				if (!address) {
					console.error('memory address required');
					console.log('Usage: vdb mem <address> [count] [offset]');
					console.log('Example: vdb mem 0x1234ABCD 32');
					return;
				}
				
				const count = args[2] ? parseInt(args[2]) : 64;
				const offset = args[3] ? parseInt(args[3]) : 0;
				
				try {
					const result = await vdb.extension_client.read_memory(address, count, offset);
					console.log(`address=${result.address} size=${count}`);
					
					if (result.data) {
						const data = Buffer.from(result.data, 'base64');
						const hex_dump = format_hex_dump(data, result.address || address);
						console.log(hex_dump);
					}
					else {
						console.log('No data available');
					}
					
					if (result.unreadable_bytes > 0)
						console.log(`unreadable_bytes=${result.unreadable_bytes}`);
				}
				catch (error) {
					console.error(error.message);
				}
				break;
				
			case 'stack':
				try {
					const call_stack = await vdb.get_call_stack();
					if (call_stack && call_stack.length > 0) {
						call_stack.forEach((thread) => {
							if (thread.frames && thread.frames.length > 0) {
								thread.frames.forEach((frame, frame_index) => {
									const location = frame.source ? `${frame.source}:${frame.line}` : 'unknown';
									console.log(`${thread.thread_id}:${frame_index} ${frame.name} ${location}`);
								});
							}
						});
					} else {
						console.log('No call stack information available');
					}
				}
				catch (error) {
					console.error(error.message);
				}
				break;
				
			case 'threads':
				try {
					const result = await vdb.extension_client.get_threads();
					result.threads.forEach(thread => {
						console.log(`${thread.id} ${thread.name}`);
					});
				}
				catch (error) {
					console.error(error.message);
				}
				break;
				
			case 'registers':
				try {
					const registers = await vdb.get_registers();
					if (Object.keys(registers).length === 0) {
						console.log('No register information available');
					} else {
						const formatted = format_registers(registers);
						console.log(formatted.trim());
					}
				}
				catch (error) {
					console.error(error.message);
				}
				break;
				
			case 'continue':
				try {
					await vdb.extension_client.continue();
					console.log('continued');
				}
				catch (error) {
					console.error(error.message);
				}
				break;
				
			case 'step':
				try {
					await vdb.extension_client.step_over();
					console.log('step over');
				}
				catch (error) {
					console.error(error.message);
				}
				break;
				
			case 'stepin':
				try {
					await vdb.extension_client.step_in();
					console.log('step in');
				}
				catch (error) {
					console.error(error.message);
				}
				break;
				
			case 'stepout':
				try {
					await vdb.extension_client.step_out();
					console.log('step out');
				}
				catch (error) {
					console.error(error.message);
				}
				break;
				
			case 'pause':
				try {
					await vdb.extension_client.pause();
					console.log('paused');
				}
				catch (error) {
					console.error(error.message);
				}
				break;
				
			case 'profiles':
				try {
					const result = await vdb.extension_client.get_profiles();
					if (result.profiles.length === 0) {
						console.log('No debug profiles found');
					} else {
						result.profiles.forEach((profile, index) => {
							console.log(`${index + 1}. ${profile.name} (${profile.type}) - ${profile.workspace}`);
						});
					}
				}
				catch (error) {
					console.error(error.message);
				}
				break;
				
			case 'start':
				const profile_name = args[1] || null;
				try {
					const result = await vdb.extension_client.start_debugging(profile_name);
					console.log(`Started debugging: ${result.profile} (${result.type})`);
				}
				catch (error) {
					console.error(error.message);
				}
				break;
				
			case 'break':
				const break_action = args[1];
				if (!break_action) {
					console.error('break action required (add, remove, list)');
					console.log('Usage: vdb break add <file> <line> [condition]');
					console.log('       vdb break remove <file> [line] [line2...]');
					console.log('       vdb break list');
					return;
				}
				
				if (break_action === 'list') {
					try {
						const result = await vdb.extension_client.get_all_breakpoints();
						if (result.breakpoints.length === 0) {
							console.log('No breakpoints set');
						} else {
							result.breakpoints.forEach(bp => {
								const status = bp.enabled ? 'enabled' : 'disabled';
								let output = `${bp.file}:${bp.line} (${status})`;
								
								if (bp.condition) {
									output += ` - condition: ${bp.condition}`;
								} else if (bp.hitCondition) {
									output += ` - hit count: ${bp.hitCondition}`;
								} else if (bp.logMessage) {
									output += ` - log: ${bp.logMessage}`;
								}
								
								console.log(output);
							});
						}
					}
					catch (error) {
						console.error(error.message);
					}
				} else if (break_action === 'add') {
					const file = args[2];
					const remaining_args = args.slice(3);
					
					if (!file || remaining_args.length === 0) {
						console.error('file and line number required');
						console.log('Usage: vdb break add <file> <line> [condition]');
						return;
					}
					
					// Parse line numbers and condition
					const line_args = [];
					let condition = null;
					
					for (const arg of remaining_args) {
						const parsed = parseInt(arg);
						if (!isNaN(parsed)) {
							line_args.push(parsed);
						} else {
							// Non-numeric argument is treated as condition (should be last)
							condition = arg;
							break;
						}
					}
					
					if (line_args.length === 0) {
						console.error('at least one line number required');
						console.log('Usage: vdb break add <file> <line> [condition]');
						return;
					}
					
					try {
						const result = await vdb.extension_client.add_breakpoints(file, line_args, condition);
						if (condition) {
							console.log(`Added ${line_args.length} conditional breakpoint(s) to ${file} with condition: ${condition}`);
						} else {
							console.log(`Added ${line_args.length} breakpoint(s) to ${file}`);
						}
					}
					catch (error) {
						console.error(error.message);
					}
				} else if (break_action === 'remove') {
					const file = args[2];
					const lines = args.slice(3).map(l => parseInt(l));
					
					if (!file) {
						console.error('file required');
						console.log('Usage: vdb break remove <file> [line] [line2...]');
						return;
					}
					
					try {
						const result = await vdb.extension_client.remove_breakpoints(file, lines.length > 0 ? lines : null);
						if (lines.length > 0) {
							console.log(`Removed breakpoint(s) at lines ${lines.join(', ')} from ${file}`);
						} else {
							console.log(`Removed all breakpoints from ${file}`);
						}
					}
					catch (error) {
						console.error(error.message);
					}
				} else {
					console.error(`Unknown break action: ${break_action}`);
				}
				break;
				
			case 'disasm':
				let disasm_address = args[1] || null;
				const disasm_count = args[2] ? parseInt(args[2]) : 10;
				
				try {
					// If no address specified, try to get current execution point
					if (!disasm_address) {
						const call_stack = await vdb.get_call_stack();
						if (call_stack && call_stack.length > 0 && call_stack[0].frames && call_stack[0].frames.length > 0) {
							// Use current frame's address or a fallback
							const frame = call_stack[0].frames[0];
							if (frame.instruction_pointer_reference) {
								disasm_address = frame.instruction_pointer_reference;
							} else {
								console.error('no current execution point available - address required');
								console.log('Usage: vdb disasm <address> [count]');
								console.log('Example: vdb disasm 0x1234ABCD 20');
								return;
							}
						} else {
							console.error('no active debug session or current execution point - address required');
							console.log('Usage: vdb disasm <address> [count]');
							console.log('Example: vdb disasm 0x1234ABCD 20');
							return;
						}
					}
					
					const result = await vdb.extension_client.disassemble(disasm_address, disasm_count);
					if (result.instructions && result.instructions.length > 0) {
						const formatted = format_disassembly(result.instructions);
						console.log(formatted);
					} else {
						console.log('No disassembly data available');
					}
				}
				catch (error) {
					console.error(error.message);
				}
				break;
				
			case 'status':
				const info = await vdb.get_status_info();
				console.log(`status=${info.available ? 'available' : 'no_session'}`);
				console.log(`extension=${info.extension_available ? 'available' : 'not_installed'}`);
				
				if (info.available && info.session) {
					console.log(`session=${info.session.name || info.session.pid || 'unknown'}`);
					console.log(`type=${info.session.type || 'unknown'}`);

					if (info.session.isRunning !== undefined)
						console.log(`running=${info.session.isRunning ? 'yes' : 'no'}`);
					
					if (info.execution) {
						console.log(`execution=${info.execution.state || 'unknown'}`);
						
						if (info.execution.state === 'stopped') {
							if (info.execution.stop_reason)
								console.log(`stop_reason=${info.execution.stop_reason}`);
							
							if (info.execution.stopped_at_breakpoint && info.execution.stop_location) {
								const location = info.execution.stop_location;
								if (location.file && location.line)
									console.log(`breakpoint=${location.file}:${location.line}`);

								if (location.function)
									console.log(`function=${location.function}`);
								
								try {
									const breakpoints = await vdb.extension_client.get_all_breakpoints();
									if (breakpoints.breakpoints) {
										const matching_bp = breakpoints.breakpoints.find(bp => 
											bp.file === location.file && bp.line === location.line
										);
										if (matching_bp) {
											if (matching_bp.condition) {
												console.log(`condition=${matching_bp.condition}`);
											} else if (matching_bp.hitCondition) {
												console.log(`hit_condition=${matching_bp.hitCondition}`);
											} else if (matching_bp.logMessage) {
												console.log(`log_message=${matching_bp.logMessage}`);
											}
										}
									}
								} catch (error) {
									// ignore
								}
							} else if (info.execution.stop_location) {
								const location = info.execution.stop_location;
								if (location.file && location.line)
									console.log(`location=${location.file}:${location.line}`);

								if (location.function)
									console.log(`function=${location.function}`);
							}
						}
					}
				}
				break;
				
			default:
				console.log('Debug Session Management:');
				console.log('profiles            List available debug configurations');
				console.log('start [profile]     Start debugging (optionally specify profile name)');
				console.log('status              Check debug and extension status (default)');
				console.log('wait [events] [timeout] Wait for debug events (comma-separated)');
				console.log('events              Monitor all DAP events in real-time');
				console.log('');
				console.log('Breakpoint Management:');
				console.log('break list          List all breakpoints');
				console.log('break add <file> <line> [condition]  Add breakpoint (with optional condition)');
				console.log('break remove <file> [line] [line2...] Remove breakpoints');
				console.log('');
				console.log('Debug Information (requires active session):');
				console.log('var <name>          Get variable value');
				console.log('vars                List all variables');
				console.log('eval <expression>   Evaluate expression');
				console.log('mem <addr> [sz]     Read memory at address');
				console.log('disasm [addr] [cnt] Show disassembly at address (or current location)');
				console.log('stack               Show call stack');
				console.log('threads             List all threads');
				console.log('registers           Show CPU registers');
				console.log('');
				console.log('Debug Control (requires active session):');
				console.log('continue            Continue execution');
				console.log('step                Step over');
				console.log('stepin              Step in');
				console.log('stepout             Step out');
				console.log('pause               Pause execution');
				console.log('');
				console.log('Options:');
				console.log('--port=<port>       Connect to extension on custom port (default: 3579)');
				console.log('--host=<host>       Connect to extension on custom host (default: localhost)');
		}
	}
	catch (error) {
		console.error('error:', error.message);
		process.exit(1);
	} finally {
		if (vdb?.extension_client?.connected)
			vdb.extension_client.disconnect();
	}
}

if (import.meta.main)
	main().catch(console.error);

export { create_vscode_debug_bridge, create_vscode_extension_client };