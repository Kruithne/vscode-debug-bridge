<p align="center"><img src="res/logo.png"/></p>

# vscode-debug-bridge &middot; [![license badge](https://img.shields.io/github/license/Kruithne/devkit?color=yellow)](LICENSE) ![typescript](https://img.shields.io/badge/vscode-1.75.0+-blue) ![node](https://img.shields.io/badge/node.js-339933) ![bun](https://img.shields.io/badge/bun-FBF0DF)

`vscode-debug-bridge` or `vdb` is a command-line tool that provides direct interaction with live debugging sessions in VSCode.

## Installation

```bash
git clone https://github.com/Kruithne/vscode-debug-bridge.git

bun link # or npm, etc

cd vscode-debug-bridge
bun install # or npm, etc

# unix
./install-extension.sh

# windows
./install-extension.bat
```

## ⌨️ Usage

### Debug Session Management

#### vdb profiles

List available debug configurations from `.vscode/launch.json`:

```bash
> vdb profiles
1. Debug (Windows) (cppvsdbg) - test
2. Debug (Linux) (cppdbg) - test
```

#### vdb start

Start a debugging session. Optionally specify a profile name:

```bash
> vdb start
Started debugging: Debug (Windows) (cppvsdbg)

> vdb start "Debug (Linux)"
Started debugging: Debug (Linux) (cppdbg)
```

### Breakpoint Management

#### vdb break list

List all current breakpoints:

```bash
> vdb break list
C:\path\to\file.c:25 (enabled)
C:\path\to\file.c:40 (enabled)
```

#### vdb break add

Add breakpoints to specific lines. Optionally specify a condition:

```bash
# Basic breakpoint
> vdb break add C:\path\to\file.c 25
Added 1 breakpoint(s) to C:\path\to\file.c

# Conditional breakpoint (expression)
> vdb break add C:\path\to\file.c 27 "i == 2"
Added 1 conditional breakpoint(s) to C:\path\to\file.c with condition: i == 2

# Hit count breakpoint
> vdb break add C:\path\to\file.c 30 ">5"
Added 1 conditional breakpoint(s) to C:\path\to\file.c with condition: >5

# Log message breakpoint
> vdb break add C:\path\to\file.c 35 "Loop iteration {i}"
Added 1 conditional breakpoint(s) to C:\path\to\file.c with condition: Loop iteration {i}
```

#### vdb break remove

Remove breakpoints. Omit line numbers to remove all breakpoints from a file:

```bash
> vdb break remove C:\path\to\file.c 25
Removed breakpoint(s) at lines 25 from C:\path\to\file.c

> vdb break remove C:\path\to\file.c
Removed all breakpoints from C:\path\to\file.c
```

### Debug Information

#### vdb status

Check debug session and extension availability:

```bash
> vdb status
status=available
extension=available
session=Debug C3 (Windows)
type=cppvsdbg
running=yes
execution=stopped
stop_reason=breakpoint
breakpoint=d:\vscode-debug-bridge\test\src\debug-test.c3:34
function=debug-windows-x64.exe!main() Line 34
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

### vdb disasm

Show disassembly at a specific memory address:

```bash
# Show 10 instructions (default) at address
> vdb disasm 0x00007ff8ca34259d 10
0x00007FF8CA34259D8B C8               mov         ecx,eax
0x00007FF8CA34259F48 FF 15 8A 38 07 00call        qword ptr [7FF8CA3B5E30h]
0x00007FF8CA3425A60F 1F 44 00 00      nop         dword ptr [rax+rax]
0x00007FF8CA3425ABCC                  int         3
0x00007FF8CA3425AC48 FF 15 1D 40 07 00call        qword ptr [7FF8CA3B65D0h]
0x00007FF8CA3425B30F 1F 44 00 00      nop         dword ptr [rax+rax]
0x00007FF8CA3425B8A8 10               test        al,10h
0x00007FF8CA3425BA74 1B               je          00007FF8CA3425D7
0x00007FF8CA3425BC48 8D 05 1D BA FF FFlea         rax,[7FF8CA33DFE0h]
0x00007FF8CA3425C348 89 05 66 77 0A 00mov         qword ptr [7FF8CA3E9D30h],rax
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

### vdb registers

Show CPU registers with hierarchical organization by category:

```bash
> vdb registers
CPU:
  RAX=0000000000000002  RBX=000001B0703DCF30  RCX=0000000000000019
  RDX=00007FF8C972F4F8  RSI=0000000000000000  RDI=000001B0703E32B0
  R8 =00000026B010C2A0  R9 =000001B0703DF1C8  R10=00007FF8C9730990
  R11=00007FF8503F2944  R12=0000000000000000  R13=0000000000000000
  R14=0000000000000000  R15=0000000000000000  RIP=00007FF77708E4CB
  RSP=00000026B010F790  RBP=00000026B010F810  EFL=00000297

CPU Segments:
  CS=0033  DS=002B  ES=002B
  SS=002B  FS=0053  GS=002B

Floating Point:
  ST0=+0.0000000000000000e+0000  
  ST1=+0.0000000000000000e+0000  
  ST2=+0.0000000000000000e+0000  
  ST3=+0.0000000000000000e+0000  
  ST4=+0.0000000000000000e+0000  
  ST5=+0.0000000000000000e+0000  
  ST6=+0.0000000000000000e+0000  
  ST7=+0.0000000000000000e+0000  
  CTRL=027F
  STAT=0000
  TAGS=0000
  EIP=00000000
  EDO=00000000

MMX:
  MM0=0000000000000000  MM1=0000000000000000  MM2=0000000000000000
  MM3=0000000000000000  MM4=0000000000000000  MM5=0000000000000000
  MM6=0000000000000000  MM7=0000000000000000

SSE:
  XMM0=000001B0703E05C0-00007FF8C972F0C0
  XMM1=0000000000000000-0000000000000000
  XMM2=0000000000000000-0000000000000000
  XMM3=0000000000000000-0000000000000000
  XMM4=0000000000000000-0000000000000000
  XMM5=0000000000000000-0000000000000000
  XMM6=0000000000000000-0000000000000000
  XMM7=0000000000000000-0000000000000000
  XMM8=0000000000000000-0000000000000000
  XMM9=0000000000000000-0000000000000000
  XMM10=0000000000000000-0000000000000000
  XMM11=0000000000000000-0000000000000000
  XMM12=0000000000000000-0000000000000000
  XMM13=0000000000000000-0000000000000000
  XMM14=0000000000000000-0000000000000000
  XMM15=0000000000000000-0000000000000000
  MXCSR=00001F80

AVX:
  YMM0=0000000000000000-0000000000000000-0000000000000000-0000000000000000
  YMM1=0000000000000000-0000000000000000-0000000000000000-0000000000000000
  YMM2=0000000000000000-0000000000000000-0000000000000000-0000000000000000
  YMM3=0000000000000000-0000000000000000-0000000000000000-0000000000000000
  YMM4=0000000000000000-0000000000000000-0000000000000000-0000000000000000
  YMM5=0000000000000000-0000000000000000-0000000000000000-0000000000000000
  YMM6=0000000000000000-0000000000000000-0000000000000000-0000000000000000
  YMM7=0000000000000000-0000000000000000-0000000000000000-0000000000000000
  YMM8=0000000000000000-0000000000000000-0000000000000000-0000000000000000
  YMM9=0000000000000000-0000000000000000-0000000000000000-0000000000000000
  YMM10=0000000000000000-0000000000000000-0000000000000000-0000000000000000
  YMM11=0000000000000000-0000000000000000-0000000000000000-0000000000000000
  YMM12=0000000000000000-0000000000000000-0000000000000000-0000000000000000
  YMM13=0000000000000000-0000000000000000-0000000000000000-0000000000000000
  YMM14=0000000000000000-0000000000000000-0000000000000000-0000000000000000
  YMM15=0000000000000000-0000000000000000-0000000000000000-0000000000000000

CET - Shadow Stack Pointer:
  SSP=0000000000000000

Flags:
  OV=0  UP=0  EI=1
  PL=1  ZR=0  AC=1
  PE=1  CY=1

Effective Address:
  0x00000026B010FBDC=00000001
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
Debug Session Management:
profiles            List available debug configurations
start [profile]     Start debugging (optionally specify profile name)
status              Check debug and extension status (default)

Breakpoint Management:
break list          List all breakpoints
break add <file> <line> [condition]  Add breakpoint (with optional condition)
break remove <file> [line] [line2...] Remove breakpoints

Debug Information (requires active session):
var <name>          Get variable value
vars                List all variables
eval <expression>   Evaluate expression
mem <addr> [sz]     Read memory at address
disasm [addr] [cnt] Show disassembly at address (or current location)
stack               Show call stack
threads             List all threads
registers           Show CPU registers

Debug Control (requires active session):
continue            Continue execution
step                Step over
stepin              Step in
stepout             Step out
pause               Pause execution

Internal
events              Monitor internal DAP events.

Options:
--port=<port>       Connect to extension on custom port (default: 3579)
```

## ⚖️ Legal

The code is available under AGPL-3.0 - you're welcome to use it for any purpose, but any derivative works (including web services) must also be open sourced under AGPL-3.0.