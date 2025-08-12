const vscode = require('vscode');
const { WebSocketServer } = require('ws');

let wss = null;
let current_session = null;
let debug_state = {
	variables: {},
	call_stack: [],
	threads: [],
	breakpoints: new Set(),
	data_breakpoints: new Set(),
	is_running: false,
	current_frame: null,
	execution_state: 'unknown',
	stop_reason: null,
	stop_location: null,
	stopped_at_breakpoint: false,
	supports_data_breakpoints: false
};

const clients = new Set();

const broadcast_event = (event_type, data) => {
	const message = JSON.stringify({
		type: 'event',
		event: event_type,
		data,
		timestamp: new Date().toISOString()
	});
	
	clients.forEach(client => {
		if (client.readyState === client.OPEN) {
			try {
				client.send(message);
			} catch (error) {
				console.warn('VDB: Failed to send event to client:', error.message);
			}
		}
	});
};

const send_response = (client, id, success, data = null, error = null) => {
	const response = {
		id,
		success,
		data: success ? data : null,
		error: success ? null : error
	};
	
	try {
		client.send(JSON.stringify(response));
	} catch (err) {
		console.warn('VDB: Failed to send response to client:', err.message);
	}
};

const send_error = (client, id, error_message) => {
	send_response(client, id, false, null, error_message);
};

const get_variables = async () => {
	if (!current_session)
		throw new Error('No active debug session');
	
	const debug_session = vscode.debug.activeDebugSession;
	if (!debug_session)
		throw new Error('No active debug session found');
	
	const threads = await debug_session.customRequest('threads');
	if (!threads?.threads?.length)
		throw new Error('No threads found');
	
	const thread_id = threads.threads[0].id;
	const stack_trace = await debug_session.customRequest('stackTrace', { threadId: thread_id });
	
	if (!stack_trace.stackFrames?.length)
		throw new Error('No stack frames found');
	
	const frame_id = stack_trace.stackFrames[0].id;
	const scopes = await debug_session.customRequest('scopes', { frameId: frame_id });
	const variables = {};
	
	if (scopes.scopes) {
		for (const scope of scopes.scopes) {
			if (scope.name.toLowerCase().includes('register'))
				continue;
			
			if (scope.variablesReference > 0) {
				const scope_vars = await debug_session.customRequest('variables', {
					variablesReference: scope.variablesReference
				});
				
				if (scope_vars.variables) {
					for (const variable of scope_vars.variables) {
						variables[variable.name] = {
							value: variable.value,
							type: variable.type,
							variables_reference: variable.variablesReference,
							scope: scope.name
						};
					}
				}
			}
		}
	}
	
	return variables;
};

const get_variable = async (name) => {
	const variables = await get_variables();
	if (!variables[name])
		throw new Error(`Variable '${name}' not found in current scope`);
	
	return variables[name];
};

const evaluate_expression = async (expression, frame_id = null, context = 'watch') => {
	if (!current_session)
		throw new Error('No active debug session');
	
	const debug_session = vscode.debug.activeDebugSession;
	if (!debug_session)
		throw new Error('No active debug session found');
	
	if (frame_id === null) {
		const threads = await debug_session.customRequest('threads');
		if (!threads?.threads?.length)
			throw new Error('No threads available for expression evaluation');
		
		const thread_id = threads.threads[0].id;
		const stack_trace = await debug_session.customRequest('stackTrace', { threadId: thread_id });
		frame_id = stack_trace.stackFrames[0]?.id;
	}
	
	const result = await debug_session.customRequest('evaluate', {
		expression,
		frameId: frame_id,
		context
	});
	
	return {
		value: result.result,
		type: result.type,
		variables_reference: result.variablesReference
	};
};

const get_call_stack = async () => {
	const debug_session = vscode.debug.activeDebugSession;
	if (!debug_session)
		throw new Error('No active debug session');
	
	const threads = await debug_session.customRequest('threads');
	const call_stacks = [];
	
	if (threads.threads) {
		for (const thread of threads.threads) {
			const stack_trace = await debug_session.customRequest('stackTrace', {
				threadId: thread.id
			});
			
			call_stacks.push({
				thread_id: thread.id,
				thread_name: thread.name,
				frames: stack_trace.stackFrames?.map(frame => ({
					id: frame.id,
					name: frame.name,
					source: frame.source?.path || frame.source?.name,
					line: frame.line,
					column: frame.column,
					instruction_pointer_reference: frame.instructionPointerReference
				})) || []
			});
		}
	}
	
	return call_stacks;
};

const get_threads = async () => {
	const debug_session = vscode.debug.activeDebugSession;
	if (!debug_session)
		throw new Error('No active debug session');
	
	const threads = await debug_session.customRequest('threads');
	return threads.threads || [];
};

const get_registers = async () => {
	if (!current_session)
		throw new Error('No active debug session');
	
	const debug_session = vscode.debug.activeDebugSession;
	if (!debug_session)
		throw new Error('No active debug session found');
	
	const threads = await debug_session.customRequest('threads');
	if (!threads?.threads?.length)
		throw new Error('No threads found');
	
	const thread_id = threads.threads[0].id;
	const stack_trace = await debug_session.customRequest('stackTrace', { threadId: thread_id });
	
	if (!stack_trace.stackFrames?.length)
		throw new Error('No stack frames found');
	
	const frame_id = stack_trace.stackFrames[0].id;
	const scopes = await debug_session.customRequest('scopes', { frameId: frame_id });
	
	const registers = {};
	
	if (scopes.scopes) {
		for (const scope of scopes.scopes) {
			if (scope.name.toLowerCase().includes('register') && scope.variablesReference > 0) {
				const scope_vars = await debug_session.customRequest('variables', {
					variablesReference: scope.variablesReference
				});
				
				if (scope_vars.variables)
					await process_register_variables(debug_session, scope_vars.variables, registers, scope.name);
			}
		}
	}
	
	return registers;
};

const process_register_variables = async (debug_session, variables, registers, category_name) => {
	for (const variable of variables) {
		if (variable.variablesReference > 0) {
			const nested_vars = await debug_session.customRequest('variables', {
				variablesReference: variable.variablesReference
			});
			
			if (nested_vars.variables) {
				if (!registers[variable.name])
					registers[variable.name] = {};

				await process_register_variables(debug_session, nested_vars.variables, registers[variable.name], variable.name);
			}
		} else {
			if (!registers[category_name])
				registers[category_name] = {};

			registers[category_name][variable.name] = {
				value: variable.value,
				type: variable.type,
				description: variable.evaluateName || variable.name
			};
		}
	}
};

const get_disassembly = async (address = null, count = 10, offset = 0) => {
	if (!current_session)
		throw new Error('No active debug session');
	
	const debug_session = vscode.debug.activeDebugSession;
	if (!debug_session)
		throw new Error('No active debug session found');
	
	let memory_reference = address;
	
	// If no address specified, try to get current instruction pointer
	if (!memory_reference) {
		const threads = await debug_session.customRequest('threads');
		if (!threads?.threads?.length)
			throw new Error('No threads found');
		
		const thread_id = threads.threads[0].id;
		const stack_trace = await debug_session.customRequest('stackTrace', { threadId: thread_id });
		
		if (!stack_trace.stackFrames?.length)
			throw new Error('No stack frames found');
		
		// Try to get instruction pointer from the frame
		const frame = stack_trace.stackFrames[0];
		if (frame.instructionPointerReference) {
			memory_reference = frame.instructionPointerReference;
		} else {
			throw new Error('No current execution point available - address required');
		}
	}
	
	try {
		const result = await debug_session.customRequest('disassemble', {
			memoryReference: memory_reference.toString(),
			instructionCount: count,
			offset: offset,
			resolveSymbols: true
		});
		
		return {
			address: memory_reference,
			instructions: result.instructions || []
		};
	} catch (error) {
		throw new Error(`Failed to disassemble at address ${memory_reference}: ${error.message}`);
	}
};

const parse_condition = (condition_str) => {
	if (!condition_str) return {};
	
	// Log message: contains {...}
	if (condition_str.includes('{') && condition_str.includes('}')) {
		return { logMessage: condition_str };
	}
	
	// Hit condition: starts with comparison operators or %
	if (/^(>|<|>=|<=|==|!=|%)/.test(condition_str.trim())) {
		return { hitCondition: condition_str };
	}
	
	// Expression condition: everything else
	return { condition: condition_str };
};

const set_breakpoints = async (file, lines, condition = null) => {
	const uri = vscode.Uri.file(file);
	const lineNumbers = Array.isArray(lines) ? lines : [lines];
	const conditionProps = parse_condition(condition);
	
	// Create breakpoints using VSCode's breakpoint API
	const breakpoints = lineNumbers.map(line => 
		new vscode.SourceBreakpoint(
			new vscode.Location(uri, new vscode.Position(line - 1, 0)),
			undefined, // enabled
			conditionProps.condition,
			conditionProps.hitCondition,
			conditionProps.logMessage
		)
	);
	
	// Add breakpoints to VSCode
	vscode.debug.addBreakpoints(breakpoints);
	
	// If there's an active debug session, also set them via DAP
	const debug_session = vscode.debug.activeDebugSession;
	if (debug_session) {
		try {
			const dapBreakpoints = lineNumbers.map(line => {
				const bp = { line };
				if (conditionProps.condition) bp.condition = conditionProps.condition;
				if (conditionProps.hitCondition) bp.hitCondition = conditionProps.hitCondition;
				if (conditionProps.logMessage) bp.logMessage = conditionProps.logMessage;
				return bp;
			});
			
			const result = await debug_session.customRequest('setBreakpoints', {
				source: { path: file },
				breakpoints: dapBreakpoints
			});
			return { vscode: breakpoints.length, dap: result };
		} catch (error) {
			return { vscode: breakpoints.length, dap: null, error: error.message };
		}
	}
	
	return { vscode: breakpoints.length, dap: null };
};

const clear_breakpoints = async (file, lines = null) => {
	const uri = vscode.Uri.file(file);
	
	// Get existing breakpoints for this file
	const existingBreakpoints = vscode.debug.breakpoints.filter(bp => 
		bp instanceof vscode.SourceBreakpoint && 
		bp.location.uri.fsPath === uri.fsPath
	);
	
	let breakpointsToRemove = [];
	
	if (lines === null) {
		// Remove all breakpoints in the file
		breakpointsToRemove = existingBreakpoints;
	} else {
		// Remove specific lines
		const lineNumbers = Array.isArray(lines) ? lines : [lines];
		breakpointsToRemove = existingBreakpoints.filter(bp => 
			lineNumbers.includes(bp.location.range.start.line + 1)
		);
	}
	
	// Remove breakpoints from VSCode
	if (breakpointsToRemove.length > 0) {
		vscode.debug.removeBreakpoints(breakpointsToRemove);
	}
	
	// If there's an active debug session, also clear them via DAP
	const debug_session = vscode.debug.activeDebugSession;
	if (debug_session) {
		try {
			const remainingLines = existingBreakpoints
				.filter(bp => !breakpointsToRemove.includes(bp))
				.map(bp => ({ line: bp.location.range.start.line + 1 }));
				
			const result = await debug_session.customRequest('setBreakpoints', {
				source: { path: file },
				breakpoints: remainingLines
			});
			return { vscode: breakpointsToRemove.length, dap: result };
		} catch (error) {
			return { vscode: breakpointsToRemove.length, dap: null, error: error.message };
		}
	}
	
	return { vscode: breakpointsToRemove.length, dap: null };
};

const get_breakpoints = () => {
	const sourceBreakpoints = vscode.debug.breakpoints.filter(bp => 
		bp instanceof vscode.SourceBreakpoint
	);
	
	return sourceBreakpoints.map(bp => ({
		file: bp.location.uri.fsPath,
		line: bp.location.range.start.line + 1,
		enabled: bp.enabled,
		condition: bp.condition || null,
		hitCondition: bp.hitCondition || null,
		logMessage: bp.logMessage || null,
		type: 'source'
	}));
};

const check_data_breakpoint_capabilities = async () => {
	const debug_session = vscode.debug.activeDebugSession;
	if (!debug_session)
		return false;
	
	try {
		const capabilities = debug_session.configuration.capabilities || debug_session.capabilities;
		
		if (capabilities && capabilities.supportsDataBreakpoints) {
			debug_state.supports_data_breakpoints = true;
			return true;
		}
		
		const result = await debug_session.customRequest('capabilities');
		debug_state.supports_data_breakpoints = result?.supportsDataBreakpoints || false;
		return debug_state.supports_data_breakpoints;
	} catch (error) {
		debug_state.supports_data_breakpoints = false;
		return false;
	}
};

const get_data_breakpoint_info = async (variable_name = null, variables_reference = null) => {
	const debug_session = vscode.debug.activeDebugSession;
	if (!debug_session)
		throw new Error('No active debug session');
	
	if (!debug_state.supports_data_breakpoints)
		throw new Error('Data breakpoints are not supported by the current debug adapter');
	
	try {
		const result = await debug_session.customRequest('dataBreakpointInfo', {
			name: variable_name,
			variablesReference: variables_reference
		});
		
		return {
			dataId: result.dataId,
			description: result.description,
			accessTypes: result.accessTypes || ['read', 'write', 'readWrite'],
			canPersist: result.canPersist || false
		};
	} catch (error) {
		throw new Error(`Failed to get data breakpoint info: ${error.message}`);
	}
};

const set_data_breakpoints = async (data_breakpoints = []) => {
	const debug_session = vscode.debug.activeDebugSession;
	if (!debug_session)
		throw new Error('No active debug session');
	
	if (!debug_state.supports_data_breakpoints)
		throw new Error('Data breakpoints are not supported by the current debug adapter');
	
	try {
		const result = await debug_session.customRequest('setDataBreakpoints', {
			breakpoints: data_breakpoints
		});
		
		debug_state.data_breakpoints.clear();
		if (result.breakpoints) {
			for (let i = 0; i < result.breakpoints.length; i++) {
				const bp = result.breakpoints[i];
				const original = data_breakpoints[i];
				
				if (bp.verified) {
					debug_state.data_breakpoints.add({
						dataId: original.dataId,
						accessType: original.accessType,
						condition: original.condition,
						description: original.description || 'Data breakpoint',
						verified: bp.verified,
						message: bp.message
					});
				}
			}
		}
		
		return result;
	} catch (error) {
		throw new Error(`Failed to set data breakpoints: ${error.message}`);
	}
};

const get_data_breakpoints = () => {
	return Array.from(debug_state.data_breakpoints).map(bp => ({
		dataId: bp.dataId,
		accessType: bp.accessType,
		condition: bp.condition,
		description: bp.description,
		verified: bp.verified,
		message: bp.message,
		type: 'data'
	}));
};

const debug_continue = async (thread_id = null) => {
	const debug_session = vscode.debug.activeDebugSession;
	if (!debug_session)
		throw new Error('No active debug session');
	
	if (!thread_id) {
		const threads = await debug_session.customRequest('threads');
		thread_id = threads.threads[0]?.id;
	}
	
	debug_state.execution_state = 'running';
	debug_state.stop_reason = null;
	debug_state.stop_location = null;
	debug_state.stopped_at_breakpoint = false;
	
	broadcast_event('dap:continued', {
		threadId: thread_id
	});
	
	
	return await debug_session.customRequest('continue', { threadId: thread_id });
};

const step_over = async (thread_id = null) => {
	const debug_session = vscode.debug.activeDebugSession;
	if (!debug_session)
		throw new Error('No active debug session');
	
	if (!thread_id) {
		const threads = await debug_session.customRequest('threads');
		thread_id = threads.threads[0]?.id;
	}
	
	debug_state.execution_state = 'running';
	broadcast_event('dap:continued', { threadId: thread_id });
	
	return await debug_session.customRequest('next', { threadId: thread_id });
};

const step_in = async (thread_id = null) => {
	const debug_session = vscode.debug.activeDebugSession;
	if (!debug_session)
		throw new Error('No active debug session');
	
	if (!thread_id) {
		const threads = await debug_session.customRequest('threads');
		thread_id = threads.threads[0]?.id;
	}
	
	debug_state.execution_state = 'running';
	broadcast_event('dap:continued', { threadId: thread_id });
	
	return await debug_session.customRequest('stepIn', { threadId: thread_id });
};

const step_out = async (thread_id = null) => {
	const debug_session = vscode.debug.activeDebugSession;
	if (!debug_session)
		throw new Error('No active debug session');
	
	if (!thread_id) {
		const threads = await debug_session.customRequest('threads');
		thread_id = threads.threads[0]?.id;
	}
	
	debug_state.execution_state = 'running';
	broadcast_event('dap:continued', { threadId: thread_id });
	
	return await debug_session.customRequest('stepOut', { threadId: thread_id });
};

const debug_pause = async (thread_id = null) => {
	const debug_session = vscode.debug.activeDebugSession;
	if (!debug_session)
		throw new Error('No active debug session');
	
	if (!thread_id) {
		const threads = await debug_session.customRequest('threads');
		thread_id = threads.threads[0]?.id;
	}
	
	return await debug_session.customRequest('pause', { threadId: thread_id });
};

const read_memory = async (memory_reference, count = 64, offset = 0) => {
	const debug_session = vscode.debug.activeDebugSession;
	if (!debug_session)
		throw new Error('No active debug session');
	
	try {
		const result = await debug_session.customRequest('readMemory', {
			memoryReference: memory_reference.toString(),
			count: count,
			offset: offset
		});
		
		return {
			address: result.address,
			data: result.data,
			unreadable_bytes: result.unreadableBytes || 0,
			decoded_data: result.data ? Buffer.from(result.data, 'base64') : null
		};
	} catch (error) {
		return await read_memory_via_expression(memory_reference, count, offset);
	}
};

const read_memory_via_expression = async (address, count, offset = 0) => {
	const actual_address = typeof address === 'string' ? address : `0x${address.toString(16)}`;
	const start_addr = offset === 0 ? actual_address : `(${actual_address} + ${offset})`;
	
	const bytes = [];
	for (let i = 0; i < count; i++) {
		try {
			const expression = `*((unsigned char*)(${start_addr} + ${i}))`;
			const result = await evaluate_expression(expression);
			bytes.push(parseInt(result.value));
		} catch (error) {
			break;
		}
	}
	
	const data = Buffer.from(bytes);
	return {
		address: start_addr,
		data: data.toString('base64'),
		unreadable_bytes: Math.max(0, count - bytes.length),
		decoded_data: data
	};
};

const get_debug_profiles = async () => {
	const workspaceFolders = vscode.workspace.workspaceFolders;
	if (!workspaceFolders || workspaceFolders.length === 0) {
		throw new Error('No workspace folders found');
	}
	
	const profiles = [];
	
	for (const folder of workspaceFolders) {
		const launchJsonPath = vscode.Uri.joinPath(folder.uri, '.vscode', 'launch.json');
		
		try {
			const content = await vscode.workspace.fs.readFile(launchJsonPath);
			const launchConfig = JSON.parse(content.toString());
			
			if (launchConfig.configurations && Array.isArray(launchConfig.configurations)) {
				for (const config of launchConfig.configurations) {
					profiles.push({
						name: config.name,
						type: config.type,
						request: config.request,
						workspace: folder.name,
						workspaceUri: folder.uri.toString(),
						configuration: config
					});
				}
			}
		} catch (error) {
			// launch.json doesn't exist or is invalid, skip this workspace
		}
	}
	
	return profiles;
};

const start_debug_session = async (profileName = null) => {
	const profiles = await get_debug_profiles();
	
	if (profiles.length === 0) {
		throw new Error('No debug configurations found');
	}
	
	let targetProfile;
	if (profileName) {
		targetProfile = profiles.find(p => p.name === profileName);
		if (!targetProfile) {
			throw new Error(`Debug profile '${profileName}' not found`);
		}
	} else {
		// Use the first profile as default
		targetProfile = profiles[0];
	}
	
	const workspaceFolder = vscode.workspace.workspaceFolders?.find(
		f => f.uri.toString() === targetProfile.workspaceUri
	);
	
	if (!workspaceFolder) {
		throw new Error('Workspace folder not found for debug profile');
	}
	
	const success = await vscode.debug.startDebugging(
		workspaceFolder, 
		targetProfile.configuration
	);
	
	if (!success) {
		throw new Error('Failed to start debug session');
	}
	
	return {
		profile: targetProfile.name,
		type: targetProfile.type,
		workspace: targetProfile.workspace
	};
};

const get_stop_location = async (session, threadId) => {
	try {
		const stackTrace = await session.customRequest('stackTrace', { threadId });
		if (stackTrace.stackFrames && stackTrace.stackFrames.length > 0) {
			const topFrame = stackTrace.stackFrames[0];
			return {
				file: topFrame.source?.path || topFrame.source?.name || null,
				line: topFrame.line || null,
				function: topFrame.name || null,
				column: topFrame.column || null
			};
		}
	} catch (error) {
		console.warn('VDB: Error getting stack trace:', error.message);
	}
	return null;
};

const check_if_stopped_at_breakpoint = (file, line) => {
	const breakpoints = get_breakpoints();
	const matchingBreakpoint = breakpoints.find(bp => {
		// Normalize file paths for comparison
		const bpFile = bp.file.replace(/\\/g, '/');
		const stopFile = file.replace(/\\/g, '/');
		return (bpFile === stopFile || bpFile.endsWith(stopFile) || stopFile.endsWith(bpFile)) && bp.line === line;
	});
	return matchingBreakpoint;
};

const handle_command = async (client, message) => {
	const { id, command, data = {} } = message;
	
	if (!id) {
		send_error(client, null, 'Missing message ID');
		return;
	}
	
	if (!command) {
		send_error(client, id, 'Missing command');
		return;
	}
	
	try {
		let result;
		
		switch (command) {
			case 'status':
				result = await handle_status_command();
				break;
				
			case 'variables':
				if (data.name) {
					result = await get_variable(data.name);
				} else {
					const variables = await get_variables();
					result = { variables };
				}
				break;
				
			case 'evaluate':
				if (!data.expression) {
					throw new Error('Expression is required');
				}
				result = await evaluate_expression(data.expression, data.frameId, data.context);
				break;
				
			case 'callstack':
				result = await get_call_stack();
				break;
				
			case 'threads':
				const threads = await get_threads();
				result = { threads };
				break;
				
			case 'registers':
				const registers = await get_registers();
				result = { registers };
				break;
				
			case 'disassemble':
				result = await get_disassembly(data.address, data.count, data.offset);
				break;
				
			case 'breakpoints':
				if (data.action === 'list' || !data.action) {
					const breakpoints = get_breakpoints();
					const dataBreakpoints = get_data_breakpoints();
					result = { breakpoints: [...breakpoints, ...dataBreakpoints] };
				} else if (data.action === 'set') {
					if (!data.file || !data.lines) {
						throw new Error('File and lines are required for set action');
					}
					result = await set_breakpoints(data.file, data.lines, data.condition);
				} else if (data.action === 'clear') {
					if (!data.file) {
						throw new Error('File is required for clear action');
					}
					result = await clear_breakpoints(data.file, data.lines);
				} else {
					throw new Error(`Unknown breakpoint action: ${data.action}`);
				}
				break;
				
			case 'dataBreakpointInfo':
				if (!data.name) {
					throw new Error('Variable name is required');
				}
				result = await get_data_breakpoint_info(data.name, data.variablesReference);
				break;
				
			case 'setDataBreakpoints':
				if (!Array.isArray(data.breakpoints)) {
					throw new Error('Breakpoints array is required');
				}
				result = await set_data_breakpoints(data.breakpoints);
				break;
				
			case 'control':
				if (!data.action) {
					throw new Error('Control action is required');
				}
				switch (data.action) {
					case 'continue':
						result = await debug_continue(data.threadId);
						break;
					case 'stepOver':
						result = await step_over(data.threadId);
						break;
					case 'stepIn':
						result = await step_in(data.threadId);
						break;
					case 'stepOut':
						result = await step_out(data.threadId);
						break;
					case 'pause':
						result = await debug_pause(data.threadId);
						break;
					default:
						throw new Error(`Unknown control action: ${data.action}`);
				}
				break;
				
			case 'memory':
				if (!data.address) {
					throw new Error('Memory address is required');
				}
				result = await read_memory(data.address, data.count, data.offset);
				break;
				
			case 'profiles':
				const profiles = await get_debug_profiles();
				result = { profiles };
				break;
				
			case 'start':
				result = await start_debug_session(data.profile);
				break;
				
			default:
				throw new Error(`Unknown command: ${command}`);
		}
		
		send_response(client, id, true, result);
		
	} catch (error) {
		send_error(client, id, error.message);
	}
};

const handle_status_command = async () => {
	let currentExecutionState = debug_state.execution_state;
	let currentStopLocation = debug_state.stop_location;
	let stoppedAtBreakpoint = debug_state.stopped_at_breakpoint;
	
	if (current_session) {
		try {
			const callStack = await get_call_stack();
			if (callStack && callStack.length > 0 && callStack[0].frames && callStack[0].frames.length > 0) {
				const topFrame = callStack[0].frames[0];
				currentExecutionState = 'stopped';
				currentStopLocation = {
					file: topFrame.source,
					line: topFrame.line,
					function: topFrame.name,
					column: topFrame.column
				};
				
				if (topFrame.source && topFrame.line) {
					const breakpoint = check_if_stopped_at_breakpoint(topFrame.source, topFrame.line);
					stoppedAtBreakpoint = !!breakpoint;
					if (breakpoint) {
						debug_state.execution_state = 'stopped';
						debug_state.stop_reason = 'breakpoint';
						debug_state.stop_location = currentStopLocation;
						debug_state.stopped_at_breakpoint = true;
					}
				}
			}
		} catch (error) {
			if (currentExecutionState === 'unknown')
				currentExecutionState = 'running';
		}
	}
	
	return {
		bridge_active: !!wss,
		debug_session_active: !!current_session,
		session_name: current_session?.name || null,
		session_type: current_session?.type || null,
		is_running: debug_state.is_running,
		execution_state: currentExecutionState,
		stop_reason: debug_state.stop_reason || (stoppedAtBreakpoint ? 'breakpoint' : null),
		stop_location: currentStopLocation,
		stopped_at_breakpoint: stoppedAtBreakpoint,
		timestamp: new Date().toISOString(),
		port: wss?.address()?.port || null
	};
};

const handle_websocket_connection = (ws) => {
	console.log('VDB: Client connected');
	clients.add(ws);
	
	ws.on('message', async (raw_message) => {
		try {
			const message = JSON.parse(raw_message.toString());
			await handle_command(ws, message);
		} catch (error) {
			console.warn('VDB: Invalid message from client:', error.message);
			send_error(ws, null, `Invalid message format: ${error.message}`);
		}
	});
	
	ws.on('close', () => {
		console.log('VDB: Client disconnected');
		clients.delete(ws);
	});
	
	ws.on('error', (error) => {
		console.warn('VDB: Client error:', error.message);
		clients.delete(ws);
	});
};

const setup_debug_listeners = () => {
	vscode.debug.onDidStartDebugSession(async (session) => {
		try {
			current_session = session;
			debug_state.is_running = true;
			debug_state.execution_state = 'running';
			debug_state.stop_reason = null;
			debug_state.stop_location = null;
			debug_state.stopped_at_breakpoint = false;
			console.log(`VDB: Debug session started - ${session.name} (${session.type})`);
			
			setTimeout(async () => {
				await check_data_breakpoint_capabilities();
			}, 1000);
			
			broadcast_event('dap:session_started', {
				name: session.name,
				type: session.type
			});
		} catch (error) {
			console.error('VDB: Error in onDidStartDebugSession:', error);
		}
	});
	
	vscode.debug.onDidTerminateDebugSession(session => {
		try {
			if (session === current_session) {
				console.log(`VDB: Debug session terminated - ${session.name}`);
				
				broadcast_event('dap:session_terminated', {
					name: session.name,
					type: session.type
				});
				
				current_session = null;
				debug_state = { 
					variables: {}, 
					call_stack: [], 
					threads: [],
					breakpoints: new Set(),
					data_breakpoints: new Set(),
					is_running: false,
					current_frame: null,
					execution_state: 'unknown',
					stop_reason: null,
					stop_location: null,
					stopped_at_breakpoint: false,
					supports_data_breakpoints: false
				};
			}
		} catch (error) {
			console.error('VDB: Error in onDidTerminateDebugSession:', error);
		}
	});
	
	vscode.debug.onDidChangeActiveDebugSession(session => {
		try {
			if (session && session === current_session) {
				debug_state.execution_state = 'stopped';
				debug_state.stop_reason = 'step';
				
				broadcast_event('dap:stopped', {
					reason: 'step',
					threadId: null
				});
			}
		} catch (error) {
			console.error('VDB: Error in onDidChangeActiveDebugSession:', error);
		}
	});

	vscode.debug.onDidChangeActiveStackItem(async (stack_item) => {
		try {
			if (stack_item) {
				debug_state.current_frame = stack_item;
				
				let location = { file: null, line: null, function: null, column: null };
				
				if (stack_item.session && stack_item.threadId && stack_item.frameId) {
					try {
						const stackTrace = await stack_item.session.customRequest('stackTrace', { 
							threadId: stack_item.threadId,
							startFrame: 0,
							levels: 1
						});
						
						if (stackTrace.stackFrames && stackTrace.stackFrames.length > 0) {
							const frame = stackTrace.stackFrames[0];
							location = {
								file: frame.source?.path || null,
								line: frame.line || null,
								function: frame.name || null,
								column: frame.column || null
							};
						}
					} catch (error) {
						console.warn('VDB: Failed to get stack trace:', error.message);
					}
				}
				
				if (!location.file && !location.line && debug_state.execution_state === 'stopped') {
					debug_state.execution_state = 'running';
					debug_state.stop_reason = null;
					debug_state.stop_location = null;
					debug_state.stopped_at_breakpoint = false;
					
					broadcast_event('dap:continued', {
						threadId: stack_item.threadId || null
					});
				} else if (location.file || location.line) {
					debug_state.execution_state = 'stopped';
					debug_state.stop_location = location;
					
					let reason = 'step';
					if (location.file && location.line) {
						const breakpoint = check_if_stopped_at_breakpoint(location.file, location.line);
						debug_state.stopped_at_breakpoint = !!breakpoint;
						
						if (breakpoint) {
							reason = 'breakpoint';
							broadcast_event('dap:breakpoint', {
								location,
								condition: breakpoint.condition,
								hitCondition: breakpoint.hitCondition,
								logMessage: breakpoint.logMessage
							});
						}
					}
					
					broadcast_event('dap:stopped', {
						reason,
						threadId: stack_item.threadId || null,
						location
					});
				}
			}
		} catch (error) {
			console.error('VDB: Error in onDidChangeActiveStackItem:', error);
		}
	});
	
};

const start_server = () => {
	if (wss) {
		console.log('VDB: WebSocket server already running');
		return;
	}
	
	const config = vscode.workspace.getConfiguration('vdb');
	const port = config.get('port', 3579);
	const host = config.get('host', 'localhost');
	
	wss = new WebSocketServer({ port, host });
	
	wss.on('connection', handle_websocket_connection);
	
	wss.on('listening', () => {
		const address = wss.address();
		console.log(`VDB: WebSocket server started on ws://${address.address}:${address.port}`);
	});
	
	wss.on('error', (error) => {
		console.error('VDB: WebSocket server error:', error);
		vscode.window.showErrorMessage(`VDB Bridge failed to start: ${error.message}`);
		wss = null;
	});
};

const stop_server = () => {
	if (wss) {
		clients.forEach(client => {
			if (client.readyState === client.OPEN) {
				client.close();
			}
		});
		clients.clear();
		
		wss.close(() => {
			console.log('VDB: WebSocket server stopped');
			vscode.window.showInformationMessage('VDB Bridge stopped');
		});
		wss = null;
	}
};

const activate = (context) => {
	console.log('VDB: Extension activating...');
	
	setup_debug_listeners();
	start_server();
	
	context.subscriptions.push(
		vscode.commands.registerCommand('vdb.start', () => {
			start_server();
		}),
		
		vscode.commands.registerCommand('vdb.stop', () => {
			stop_server();
		}),
		
		vscode.commands.registerCommand('vdb.status', () => {
			const status = wss ? 'Running' : 'Stopped';
			const session = current_session ? `Active: ${current_session.name}` : 'No active session';
			vscode.window.showInformationMessage(`VDB Bridge: ${status} | ${session}`);
		})
	);
	
	console.log('VDB: Extension activated');
};

const deactivate = () => {
	console.log('VDB: Extension deactivating...');
	if (wss)
		stop_server();
};

module.exports = { activate, deactivate };