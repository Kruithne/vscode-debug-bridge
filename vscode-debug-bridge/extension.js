const vscode = require('vscode');
const http = require('http');

let server = null;
let current_session = null;
let debug_state = {
	variables: {},
	call_stack: [],
	threads: [],
	breakpoints: new Set(),
	is_running: false,
	current_frame: null,
	execution_state: 'unknown', // 'running', 'stopped', 'unknown'
	stop_reason: null, // 'breakpoint', 'step', 'exception', 'pause', 'entry', etc.
	stop_location: null, // { file, line, function }
	stopped_at_breakpoint: false
};

const parse_request_body = (req) => {
	return new Promise((resolve, reject) => {
		let body = '';
		req.on('data', chunk => {
			body += chunk.toString();
		});

		req.on('end', () => {
			try {
				resolve(body ? JSON.parse(body) : {});
			} catch (error) {
				reject(error);
			}
		});
	});
};

const send_json_response = (res, status, data) => {
	res.writeHead(status, { 
		'Content-Type': 'application/json',
		'Access-Control-Allow-Origin': '*',
		'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
		'Access-Control-Allow-Headers': 'Content-Type'
	});
	res.end(JSON.stringify(data));
};

const handle_status = async (req, res) => {
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
	
	send_json_response(res, 200, {
		bridge_active: !!server,
		debug_session_active: !!current_session,
		session_name: current_session?.name || null,
		session_type: current_session?.type || null,
		is_running: debug_state.is_running,
		execution_state: currentExecutionState,
		stop_reason: debug_state.stop_reason || (stoppedAtBreakpoint ? 'breakpoint' : null),
		stop_location: currentStopLocation,
		stopped_at_breakpoint: stoppedAtBreakpoint,
		timestamp: new Date().toISOString(),
		port: server?.address()?.port || null
	});
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

const handle_variables = async (req, res) => {
	try {
		const variables = await get_variables();
		send_json_response(res, 200, { 
			variables, 
			timestamp: new Date().toISOString(),
			session_name: current_session.name
		});
	} catch (error) {
		send_json_response(res, 500, { error: error.message });
	}
};

const get_variable = async (name) => {
	const variables = await get_variables();
	if (!variables[name])
		throw new Error(`Variable '${name}' not found in current scope`);
	
	return variables[name];
};

const handle_variable_by_name = async (req, res, variable_name) => {
	try {
		const variable = await get_variable(variable_name);
		send_json_response(res, 200, { 
			name: variable_name, 
			...variable,
			timestamp: new Date().toISOString()
		});
	} catch (error) {
		send_json_response(res, 404, { error: `Variable '${variable_name}' not found: ${error.message}` });
	}
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

const handle_evaluate = async (req, res) => {
	try {
		const body = await parse_request_body(req);
		const { expression, frameId = null, context = 'watch' } = body;
		
		if (!expression) {
			send_json_response(res, 400, { error: 'Expression is required' });
			return;
		}
		
		const result = await evaluate_expression(expression, frameId, context);
		send_json_response(res, 200, { 
			expression, 
			result,
			timestamp: new Date().toISOString()
		});
	} catch (error) {
		send_json_response(res, 500, { error: error.message });
	}
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
					column: frame.column
				})) || []
			});
		}
	}
	
	return call_stacks;
};

const handle_call_stack = async (req, res) => {
	try {
		const stack = await get_call_stack();
		send_json_response(res, 200, { 
			call_stack: stack,
			timestamp: new Date().toISOString()
		});
	} catch (error) {
		send_json_response(res, 500, { error: error.message });
	}
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

const handle_threads = async (req, res) => {
	try {
		const threads = await get_threads();
		send_json_response(res, 200, { 
			threads,
			timestamp: new Date().toISOString()
		});
	} catch (error) {
		send_json_response(res, 500, { error: error.message });
	}
};

const handle_registers = async (req, res) => {
	try {
		const registers = await get_registers();
		send_json_response(res, 200, { 
			registers,
			timestamp: new Date().toISOString()
		});
	} catch (error) {
		send_json_response(res, 500, { error: error.message });
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
		logMessage: bp.logMessage || null
	}));
};

const handle_breakpoints = async (req, res) => {
	try {
		if (req.method === 'GET') {
			// List all breakpoints
			const breakpoints = get_breakpoints();
			send_json_response(res, 200, { 
				breakpoints,
				timestamp: new Date().toISOString()
			});
			return;
		}
		
		const body = await parse_request_body(req);
		const { file, lines, action = 'set', condition = null } = body;
		
		if (!file) {
			send_json_response(res, 400, { error: 'File is required' });
			return;
		}
		
		let result;
		if (action === 'set') {
			if (!lines) {
				send_json_response(res, 400, { error: 'Lines are required for set action' });
				return;
			}
			result = await set_breakpoints(file, lines, condition);
		} else if (action === 'clear') {
			result = await clear_breakpoints(file, lines);
		} else {
			send_json_response(res, 400, { error: 'Action must be "set" or "clear"' });
			return;
		}
		
		send_json_response(res, 200, { 
			success: true, 
			file, 
			lines, 
			action,
			result,
			timestamp: new Date().toISOString()
		});
	} catch (error) {
		send_json_response(res, 500, { error: error.message });
	}
};

const debug_continue = async (thread_id = null) => {
	const debug_session = vscode.debug.activeDebugSession;
	if (!debug_session)
		throw new Error('No active debug session');
	
	if (!thread_id) {
		const threads = await debug_session.customRequest('threads');
		thread_id = threads.threads[0]?.id;
	}
	
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

const handle_control = async (req, res) => {
	try {
		const body = await parse_request_body(req);
		const { action, threadId = null } = body;
		
		if (!action) {
			send_json_response(res, 400, { error: 'Action is required' });
			return;
		}
		
		let result;
		switch (action) {
			case 'continue':
				result = await debug_continue(threadId);
				break;

			case 'stepOver':
				result = await step_over(threadId);
				break;
				
			case 'stepIn':
				result = await step_in(threadId);
				break;

			case 'stepOut':
				result = await step_out(threadId);
				break;

			case 'pause':
				result = await debug_pause(threadId);
				break;

			default:
				send_json_response(res, 400, { error: `Unknown action: ${action}` });
				return;
		}
		
		send_json_response(res, 200, { 
			action, 
			result,
			timestamp: new Date().toISOString()
		});
	} catch (error) {
		send_json_response(res, 500, { error: error.message });
	}
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

const handle_memory = async (req, res) => {
	try {
		const body = await parse_request_body(req);
		const { address, count = 64, offset = 0 } = body;
		
		if (!address) {
			send_json_response(res, 400, { error: 'Memory address is required' });
			return;
		}
		
		const result = await read_memory(address, count, offset);
		send_json_response(res, 200, { 
			address,
			count,
			offset,
			result,
			timestamp: new Date().toISOString()
		});
	} catch (error) {
		send_json_response(res, 500, { error: error.message });
	}
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

const handle_profiles = async (req, res) => {
	try {
		const profiles = await get_debug_profiles();
		send_json_response(res, 200, {
			profiles,
			timestamp: new Date().toISOString()
		});
	} catch (error) {
		send_json_response(res, 500, { error: error.message });
	}
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

const handle_start_debug = async (req, res) => {
	try {
		const body = await parse_request_body(req);
		const { profile = null } = body;
		
		const result = await start_debug_session(profile);
		send_json_response(res, 200, {
			success: true,
			...result,
			timestamp: new Date().toISOString()
		});
	} catch (error) {
		send_json_response(res, 500, { error: error.message });
	}
};

const handle_request = async (req, res) => {
	if (req.method === 'OPTIONS') {
		res.writeHead(200, {
			'Access-Control-Allow-Origin': '*',
			'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
			'Access-Control-Allow-Headers': 'Content-Type'
		});
		res.end();
		return;
	}
	
	const url_parts = req.url.split('?')[0].split('/').filter(Boolean);
	
	try {
		if (req.method === 'GET' && url_parts[0] === 'status')
			await handle_status(req, res);
		else if (req.method === 'GET' && url_parts[0] === 'profiles')
			await handle_profiles(req, res);
		else if (req.method === 'POST' && url_parts[0] === 'start')
			await handle_start_debug(req, res);
		else if (req.method === 'GET' && url_parts[0] === 'variables' && !url_parts[1])
			await handle_variables(req, res);
		else if (req.method === 'GET' && url_parts[0] === 'variables' && url_parts[1])
			await handle_variable_by_name(req, res, url_parts[1]);
		else if (req.method === 'GET' && url_parts[0] === 'callstack')
			await handle_call_stack(req, res);
		else if (req.method === 'GET' && url_parts[0] === 'threads')
			await handle_threads(req, res);
		else if (req.method === 'GET' && url_parts[0] === 'registers')
			await handle_registers(req, res);
		else if (req.method === 'POST' && url_parts[0] === 'evaluate')
			await handle_evaluate(req, res);
		else if ((req.method === 'POST' || req.method === 'GET') && url_parts[0] === 'breakpoints')
			await handle_breakpoints(req, res);
		else if (req.method === 'POST' && url_parts[0] === 'control')
			await handle_control(req, res);
		else if (req.method === 'POST' && url_parts[0] === 'memory')
			await handle_memory(req, res);
		else
			send_json_response(res, 404, { error: 'Not found' });
	} catch (error) {
		send_json_response(res, 500, { error: error.message });
	}
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

const setup_debug_listeners = () => {
	vscode.debug.onDidStartDebugSession(session => {
		current_session = session;
		debug_state.is_running = true;
		debug_state.execution_state = 'running';
		debug_state.stop_reason = null;
		debug_state.stop_location = null;
		debug_state.stopped_at_breakpoint = false;
		console.log(`VDB: Debug session started - ${session.name} (${session.type})`);
		
		// Listen for DAP events from this session
		session.onDidReceiveDebugSessionCustomEvent(event => {
			if (event.event === 'stopped') {
				debug_state.execution_state = 'stopped';
				debug_state.stop_reason = event.body?.reason || 'unknown';
				
				// Get current stack frame to determine location
				if (event.body?.threadId) {
					get_stop_location(session, event.body.threadId).then(location => {
						debug_state.stop_location = location;
						if (location && location.file && location.line) {
							const breakpoint = check_if_stopped_at_breakpoint(location.file, location.line);
							debug_state.stopped_at_breakpoint = !!breakpoint;
						}
					}).catch(error => {
						console.warn('VDB: Failed to get stop location:', error.message);
					});
				}
				
				console.log(`VDB: Execution stopped - reason: ${debug_state.stop_reason}`);
			} else if (event.event === 'continued') {
				debug_state.execution_state = 'running';
				debug_state.stop_reason = null;
				debug_state.stop_location = null;
				debug_state.stopped_at_breakpoint = false;
				console.log('VDB: Execution continued');
			}
		});
	});
	
	vscode.debug.onDidTerminateDebugSession(session => {
		if (session === current_session) {
			console.log(`VDB: Debug session terminated - ${session.name}`);
			current_session = null;
			debug_state = { 
				variables: {}, 
				call_stack: [], 
				threads: [],
				breakpoints: new Set(),
				is_running: false,
				current_frame: null,
				execution_state: 'unknown',
				stop_reason: null,
				stop_location: null,
				stopped_at_breakpoint: false
			};
		}
	});
	
	vscode.debug.onDidChangeActiveStackItem(async (stack_item) => {
		if (stack_item)
			debug_state.current_frame = stack_item;
	});
};

const start_server = () => {
	if (server) {
		console.log('VDB: Server already running');
		return;
	}
	
	const config = vscode.workspace.getConfiguration('vdb');
	const port = config.get('port', 3579);
	const host = config.get('host', 'localhost');
	
	server = http.createServer(handle_request);
	
	server.listen(port, host, () => {
		const address = server.address();
		console.log(`VDB: Server started on http://${address.address}:${address.port}`);
		
		vscode.window.showInformationMessage(
			`VDB Bridge started on port ${address.port}`,
			'Test Connection'
		).then(selection => {
			if (selection === 'Test Connection')
				vscode.env.openExternal(vscode.Uri.parse(`http://${host}:${port}/status`));
		});
	});
	
	server.on('error', (error) => {
		console.error('VDB: Server error:', error);
		vscode.window.showErrorMessage(`VDB Bridge failed to start: ${error.message}`);
		server = null;
	});
};

const stop_server = () => {
	if (server) {
		server.close(() => {
			console.log('VDB: Server stopped');
			vscode.window.showInformationMessage('VDB Bridge stopped');
		});
		server = null;
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
			const status = server ? 'Running' : 'Stopped';
			const session = current_session ? `Active: ${current_session.name}` : 'No active session';
			vscode.window.showInformationMessage(`VDB Bridge: ${status} | ${session}`);
		})
	);
	
	console.log('VDB: Extension activated');
};

const deactivate = () => {
	console.log('VDB: Extension deactivating...');
	if (server)
		stop_server();
};

module.exports = { activate, deactivate };