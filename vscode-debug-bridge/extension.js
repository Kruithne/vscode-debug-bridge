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
	current_frame: null
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

const handle_status = (req, res) => {
	send_json_response(res, 200, {
		bridge_active: !!server,
		debug_session_active: !!current_session,
		session_name: current_session?.name || null,
		session_type: current_session?.type || null,
		is_running: debug_state.is_running,
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

const set_breakpoints = async (file, lines) => {
	const debug_session = vscode.debug.activeDebugSession;
	if (!debug_session)
		throw new Error('No active debug session');
	
	const breakpoints = Array.isArray(lines) ? 
	lines.map(line => ({ line })) : 
	[{ line: lines }];
	
	const result = await debug_session.customRequest('setBreakpoints', {
		source: { path: file },
		breakpoints
	});
	
	return result;
};

const clear_breakpoints = async (file, lines = null) => {
	const debug_session = vscode.debug.activeDebugSession;
	if (!debug_session)
		throw new Error('No active debug session');
	
	const breakpoints = lines ? 
	(Array.isArray(lines) ? lines.map(line => ({ line })) : [{ line: lines }]) :
	[];
	
	const result = await debug_session.customRequest('setBreakpoints', {
		source: { path: file },
		breakpoints
	});
	
	return result;
};

const handle_breakpoints = async (req, res) => {
	try {
		const body = await parse_request_body(req);
		const { file, lines, action = 'set' } = body;
		
		if (!file || !lines) {
			send_json_response(res, 400, { error: 'File and lines are required' });
			return;
		}
		
		let result;
		if (action === 'set')
			result = await set_breakpoints(file, lines);
		else if (action === 'clear')
			result = await clear_breakpoints(file, lines);
		else {
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
			handle_status(req, res);
		else if (req.method === 'GET' && url_parts[0] === 'variables' && !url_parts[1])
			await handle_variables(req, res);
		else if (req.method === 'GET' && url_parts[0] === 'variables' && url_parts[1])
			await handle_variable_by_name(req, res, url_parts[1]);
		else if (req.method === 'GET' && url_parts[0] === 'callstack')
			await handle_call_stack(req, res);
		else if (req.method === 'GET' && url_parts[0] === 'threads')
			await handle_threads(req, res);
		else if (req.method === 'POST' && url_parts[0] === 'evaluate')
			await handle_evaluate(req, res);
		else if (req.method === 'POST' && url_parts[0] === 'breakpoints')
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

const setup_debug_listeners = () => {
	vscode.debug.onDidStartDebugSession(session => {
		current_session = session;
		debug_state.is_running = true;
		console.log(`VDB: Debug session started - ${session.name} (${session.type})`);
		
		const config = vscode.workspace.getConfiguration('vdb');
		if (!server && config.get('autoStart', true))
			start_server();
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
				current_frame: null
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