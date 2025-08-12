<p align="center"><img src="res/logo.png"/></p>

# vscode-debug-bridge &middot; [![license badge](https://img.shields.io/github/license/Kruithne/devkit?color=yellow)](LICENSE) ![typescript](https://img.shields.io/badge/vscode-1.75.0+-blue) ![node](https://img.shields.io/badge/node.js-339933) ![bun](https://img.shields.io/badge/bun-FBF0DF)

`vscode-debug-bridge` or `vdb` is a command-line tool that provides direct interaction with live debugging sessions in VSCode.

## Installation

```bash
git clone https://github.com/Kruithne/vscode-debug-bridge.git

# link using your preferred js runtime
npm link
bun link
# .. etc

# unix
./install-extension.sh

# windows
./install-extension.bat
```

## ⌨️ Usage

### vdb status

Check debug session and extension availability:

```bash
> vdb status
status=available
extension=available
session=Debug (Windows)
type=cppvsdbg
running=yes
```

### vdb var

Get a specific variable value:

```bash
> vdb var counter
counter=3
```

### vdb vars

List all available variables:

```bash
> vdb vars
counter=3 (int)
greeting={ptr=0x00007ff68a3758d0 "Hello DAP!" len=10 } (char[])
numbers=0x000000b0d56ffdd0 {1, 2, 3, 4, 5} (int[5])
person={name={ptr=0x00007ff68a3758db "Bridge" len=6 } age=28 } (Person)
pi=3.1415899999999999 (double)
```

### vdb eval

Evaluate expressions in the current debugging context:

```bash
> vdb eval "counter + 5"
counter + 5=8 (int)
```

### vdb mem

Read memory at a specific address:

```bash
> vdb mem 0x00007ff68a3758d0
address=0x00007ff68a3758d0 size=64
  0x7FF68A3758D0: 48 65 6C 6C 6F 20 44 41 50 21 00 42 72 69 64 67 |Hello DAP!.Bridg|
  0x7FF68A3758E0: 65 00 00 00 00 00 00 00 DB 58 37 8A F6 7F 00 00 |e........X7.....|
  0x7FF68A3758F0: 06 00 00 00 00 00 00 00 19 00 00 00 00 00 00 00 |................|
  0x7FF68A375900: 01 00 00 00 02 00 00 00 03 00 00 00 04 00 00 00 |................|
```

### vdb stack

Display the current call stack:

```bash
> vdb stack
14068:0 debug-windows-x64.exe!main() Line 35 d:\vscode-debug-bridge\test\src\debug-test.c3:35
14068:1 [Inline Frame] debug-windows-x64.exe!@main_to_void_main() Line 18 c:\c3\lib\std\core\private\main_stub.c3:18
14068:2 debug-windows-x64.exe!_$main(int .anon, char * * .anon) Line 9 d:\vscode-debug-bridge\test\src\debug-test.c3:9
```

### vdb threads

List all active threads:

```bash
> vdb threads
14068 Main Thread
27872 ntdll.dll thread
24320 ntdll.dll thread
9708 ntdll.dll thread
```

### vdb continue

Continue execution:

```bash
> vdb continue
continued
```

### vdb step

Step over the current line:

```bash
> vdb step
step over
```

### vdb stepin

Step into function calls:

```bash
> vdb stepin
step in
```

### vdb stepout

Step out of current function:

```bash
> vdb stepout
step out
```

### vdb pause

Pause execution:

```bash
> vdb pause
paused
```

### vdb help

Show available commands:

```bash
> vdb help
var <name>          Get variable value
vars                List all variables
eval <expression>   Evaluate expression
mem <addr> [sz]     Read memory at address
stack               Show call stack
threads             List all threads
continue            Continue execution
step                Step over
stepin              Step in
stepout             Step out
pause               Pause execution
status              Check debug and extension status (default)

Options:
--port=<port>       Connect to extension on custom port (default: 3579)
```

## ⚖️ Legal

The code is available under AGPL-3.0 - you're welcome to use it for any purpose, but any derivative works (including web services) must also be open sourced under AGPL-3.0.