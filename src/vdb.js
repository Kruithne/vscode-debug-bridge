#!/usr/bin/env bun


function create_vscode_extension_client(port = 3579) {
	const base_url = `http://localhost:${port}`;
	const client = {
		base_url,
		
		async is_available() {
			try {
				const response = await fetch(`${client.base_url}/status`);
				return response.ok;
			}
			catch (error) {
				return false;
			}
		},
		
		async get_status() {
			const response = await fetch(`${client.base_url}/status`);
			if (!response.ok)
				throw new Error('Extension not available');
			return await response.json();
		},
		
		async get_variables() {
			const response = await fetch(`${client.base_url}/variables`);
			if (!response.ok) {
				const error = await response.json();
				throw new Error(error.error || 'Failed to get variables');
			}
			return await response.json();
		},
		
		async get_variable(name) {
			const response = await fetch(`${client.base_url}/variables/${encodeURIComponent(name)}`);
			if (!response.ok) {
				const error = await response.json();
				throw new Error(error.error || `Variable '${name}' not found`);
			}
			return await response.json();
		},
		
		async get_call_stack() {
			const response = await fetch(`${client.base_url}/callstack`);
			if (!response.ok) {
				const error = await response.json();
				throw new Error(error.error || 'Failed to get call stack');
			}
			return await response.json();
		},
		
		async get_threads() {
			const response = await fetch(`${client.base_url}/threads`);
			if (!response.ok) {
				const error = await response.json();
				throw new Error(error.error || 'Failed to get threads');
			}
			return await response.json();
		},
		
		async evaluate_expression(expression, frame_id = null, context = 'watch') {
			const response = await fetch(`${client.base_url}/evaluate`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ expression, frameId: frame_id, context })
			});
			
			if (!response.ok) {
				const error = await response.json();
				throw new Error(error.error || 'Failed to evaluate expression');
			}
			
			return await response.json();
		},
		
		async read_memory(address, count = 64, offset = 0) {
			const response = await fetch(`${client.base_url}/memory`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ address, count, offset })
			});
			
			if (!response.ok) {
				const error = await response.json();
				throw new Error(error.error || 'Failed to read memory');
			}
			
			return await response.json();
		},
		
		async set_breakpoints(file, lines) {
			const response = await fetch(`${client.base_url}/breakpoints`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ file, lines, action: 'set' })
			});
			
			if (!response.ok) {
				const error = await response.json();
				throw new Error(error.error || 'Failed to set breakpoints');
			}
			
			return await response.json();
		},
		
		async clear_breakpoints(file, lines = null) {
			const response = await fetch(`${client.base_url}/breakpoints`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ file, lines, action: 'clear' })
			});
			
			if (!response.ok) {
				const error = await response.json();
				throw new Error(error.error || 'Failed to clear breakpoints');
			}
			
			return await response.json();
		},
		
		async continue(thread_id = null) {
			return await client.control('continue', thread_id);
		},
		
		async step_over(thread_id = null) {
			return await client.control('stepOver', thread_id);
		},
		
		async step_in(thread_id = null) {
			return await client.control('stepIn', thread_id);
		},
		
		async step_out(thread_id = null) {
			return await client.control('stepOut', thread_id);
		},
		
		async pause(thread_id = null) {
			return await client.control('pause', thread_id);
		},
		
		async control(action, thread_id = null) {
			const response = await fetch(`${client.base_url}/control`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ action, threadId: thread_id })
			});
			
			if (!response.ok) {
				const error = await response.json();
				throw new Error(error.error || `Failed to ${action}`);
			}
			
			return await response.json();
		},
		
		async get_profiles() {
			const response = await fetch(`${client.base_url}/profiles`);
			if (!response.ok) {
				const error = await response.json();
				throw new Error(error.error || 'Failed to get debug profiles');
			}
			return await response.json();
		},
		
		async start_debugging(profile_name = null) {
			const response = await fetch(`${client.base_url}/start`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ profile: profile_name })
			});
			
			if (!response.ok) {
				const error = await response.json();
				throw new Error(error.error || 'Failed to start debugging');
			}
			
			return await response.json();
		},
		
		async get_all_breakpoints() {
			const response = await fetch(`${client.base_url}/breakpoints`);
			if (!response.ok) {
				const error = await response.json();
				throw new Error(error.error || 'Failed to get breakpoints');
			}
			return await response.json();
		},
		
		async add_breakpoints(file, lines) {
			const response = await fetch(`${client.base_url}/breakpoints`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ file, lines, action: 'set' })
			});
			
			if (!response.ok) {
				const error = await response.json();
				throw new Error(error.error || 'Failed to add breakpoints');
			}
			
			return await response.json();
		},
		
		async remove_breakpoints(file, lines = null) {
			const response = await fetch(`${client.base_url}/breakpoints`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ file, lines, action: 'clear' })
			});
			
			if (!response.ok) {
				const error = await response.json();
				throw new Error(error.error || 'Failed to remove breakpoints');
			}
			
			return await response.json();
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
		if (typeof start_address === 'string' && start_address.startsWith('0x')) {
			addr = `0x${(parseInt(start_address, 16) + i).toString(16).padStart(8, '0').toUpperCase()}`;
		}
		else {
			addr = `${start_address}+${i}`;
		}
		
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

function create_vscode_debug_bridge(port = 3579) {
	const bridge = {
		extension_client: create_vscode_extension_client(port),
		extension_available: false,
		
		async initialize() {
			bridge.extension_available = await bridge.extension_client.is_available();
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
					if (status.debugSessionActive) {
						return {
							...base_info,
							available: true,
							session: {
								name: status.sessionName,
								type: status.sessionType,
								isRunning: status.isRunning
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
			return result.result;
		},
		
		async get_call_stack() {
			if (!bridge.extension_available)
				throw new Error('Call stack access requires VSCode Debug Bridge extension');
			
			const result = await bridge.extension_client.get_call_stack();
			return result.callStack;
		}
	};
	
	return bridge;
}

function parse_args(args) {
	const parsed = {
		port: 3579,
		args: []
	};
	
	for (const arg of args) {
		if (arg.startsWith('--')) {
			const [key, value] = arg.substring(2).split('=');
			
			switch (key) {
				case 'port':
					parsed.port = parseInt(value);
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
	const { port, args } = parse_args(raw_args);
	const command = args[0] || 'status';
	
	const vdb = create_vscode_debug_bridge(port);
	
	try {
		const extension_available = await vdb.initialize();
		
		if (!extension_available)
			console.error('extension not available - limited capabilities');
		
		switch (command) {
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
					
					if (result.result?.data) {
						const data = Buffer.from(result.result.data, 'base64');
						const hex_dump = format_hex_dump(data, result.result.address || address);
						console.log(hex_dump);
					}
					else {
						console.log('No data available');
					}
					
					if (result.result?.unreadableBytes > 0)
						console.log(`unreadable_bytes=${result.result.unreadableBytes}`);
				}
				catch (error) {
					console.error(error.message);
				}
				break;
				
			case 'stack':
				try {
					const call_stack = await vdb.get_call_stack();
					call_stack.forEach((thread, thread_index) => {
						thread.frames.forEach((frame, frame_index) => {
							const location = frame.source ? `${frame.source}:${frame.line}` : 'unknown';
							console.log(`${thread.threadId}:${frame_index} ${frame.name} ${location}`);
						});
					});
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
					console.log('Usage: vdb break add <file> <line> [line2...]');
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
								console.log(`${bp.file}:${bp.line} (${status})`);
							});
						}
					}
					catch (error) {
						console.error(error.message);
					}
				} else if (break_action === 'add') {
					const file = args[2];
					const lines = args.slice(3).map(l => parseInt(l));
					
					if (!file || lines.length === 0) {
						console.error('file and line numbers required');
						console.log('Usage: vdb break add <file> <line> [line2...]');
						return;
					}
					
					try {
						const result = await vdb.extension_client.add_breakpoints(file, lines);
						console.log(`Added ${lines.length} breakpoint(s) to ${file}`);
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
				
			case 'status':
				const info = await vdb.get_status_info();
				console.log(`status=${info.available ? 'available' : 'no_session'}`);
				console.log(`extension=${info.extension_available ? 'available' : 'not_installed'}`);
				
				if (info.available && info.session) {
					console.log(`session=${info.session.name || info.session.pid || 'unknown'}`);
					console.log(`type=${info.session.type || 'unknown'}`);
					if (info.session.isRunning !== undefined) {
						console.log(`running=${info.session.isRunning ? 'yes' : 'no'}`);
					}
				}
				break;
				
			default:
				console.log('Debug Session Management:');
				console.log('profiles            List available debug configurations');
				console.log('start [profile]     Start debugging (optionally specify profile name)');
				console.log('status              Check debug and extension status (default)');
				console.log('');
				console.log('Breakpoint Management:');
				console.log('break list          List all breakpoints');
				console.log('break add <file> <line> [line2...]   Add breakpoints');
				console.log('break remove <file> [line] [line2...] Remove breakpoints');
				console.log('');
				console.log('Debug Information (requires active session):');
				console.log('var <name>          Get variable value');
				console.log('vars                List all variables');
				console.log('eval <expression>   Evaluate expression');
				console.log('mem <addr> [sz]     Read memory at address');
				console.log('stack               Show call stack');
				console.log('threads             List all threads');
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
		}
	}
	catch (error) {
		console.error('error:', error.message);
		process.exit(1);
	}
}

if (import.meta.main)
	main().catch(console.error);

export { create_vscode_debug_bridge, create_vscode_extension_client };