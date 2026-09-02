-- Headless SimpleGraphic host for pob-engine.
--
-- Path of Building is written against "SimpleGraphic", a small C++ host that
-- provides rendering, input, file search, compression and a few process
-- services as Lua globals. This file provides the same globals for a headless
-- process: rendering and input are no-ops, everything else delegates to Rust
-- through the `__native` table. Mirrors src/_SimpleGraphic.def.lua upstream.
--
-- Rust sets `__pob_root`, `__user_dir` and `__native` before running this.

local root, userDir, native = __pob_root, __user_dir, __native

local function isAbsolute(p)
	local c = p:sub(1, 1)
	return c == "/" or c == "\\" or p:match("^%a:[/\\]") ~= nil
end

local function resolve(p)
	if type(p) ~= "string" or p == "" or isAbsolute(p) then
		return p
	end
	return root .. "/" .. p
end

-- PoB addresses its own files relative to the runtime's working directory.
-- Redirect relative paths to the vendored PoB root so the host process keeps
-- its own CWD. The vendored tree is read-only once installed, so writes into
-- it (PoB's runtime caches, e.g. Data/QueryMods.lua) land in a per-user
-- overlay directory instead; reads fall back to the overlay.
do
	local io_open, io_lines, os_remove, os_rename = io.open, io.lines, os.remove, os.rename
	local l_loadfile, l_dofile = loadfile, dofile
	local cacheDir = userDir .. "/pob-redux-cache"
	local function underRoot(abs)
		return abs:sub(1, #root) == root
	end
	local function cachePath(abs)
		return cacheDir .. abs:sub(#root + 1)
	end
	io.open = function(p, mode, ...)
		local abs = resolve(p)
		mode = mode or "r"
		if underRoot(abs) then
			if mode:find("[wa]") then
				local cp = cachePath(abs)
				native.make_dir(cp:match("^(.*)[/\\][^/\\]*$") or cacheDir)
				return io_open(cp, mode, ...)
			end
			local f, err = io_open(abs, mode, ...)
			if f then return f end
			local cf = io_open(cachePath(abs), mode, ...)
			if cf then return cf end
			return nil, err
		end
		return io_open(abs, mode, ...)
	end
	io.lines = function(p, ...)
		local abs = resolve(p)
		if underRoot(abs) then
			local ok, it = pcall(io_lines, abs, ...)
			if ok then return it end
			return io_lines(cachePath(abs), ...)
		end
		return io_lines(abs, ...)
	end
	os.remove = function(p)
		local abs = resolve(p)
		local ok, err = os_remove(abs)
		if not ok and underRoot(abs) then
			return os_remove(cachePath(abs))
		end
		return ok, err
	end
	os.rename = function(a, b) return os_rename(resolve(a), resolve(b)) end
	loadfile = function(p, ...)
		local abs = resolve(p)
		local f, err = l_loadfile(abs, ...)
		if f == nil and underRoot(abs) then
			local cf = l_loadfile(cachePath(abs), ...)
			if cf then return cf end
		end
		return f, err
	end
	dofile = function(p)
		local f, err = loadfile(p)
		if not f then error(err, 2) end
		return f()
	end
	package.path = table.concat({
		root .. "/?.lua", root .. "/?/init.lua",
		root .. "/lua/?.lua", root .. "/lua/?/init.lua",
	}, ";")
	package.cpath = ""
end

-- Native modules shipped with the SimpleGraphic runtime. Network and profiling
-- libraries are simply absent; lua-utf8 gets a byte-wise shim because PoB only
-- uses it with ASCII separators in number formatting. lcurl.safe gets a
-- GET-only shim over native.http_get — enough for PoB's synchronous cache
-- fills (trade-stats download); everything else stays unsupported.
do
	local absent = {
		lcurl = true, lzip = true, socket = true, ["lua-profiler"] = true,
	}
	package.preload["lua-utf8"] = function()
		return setmetatable({}, { __index = string })
	end
	package.preload["lcurl.safe"] = function()
		local M = {}
		function M.easy()
			local h = { _post = false }
			local function noop() end
			return setmetatable({}, { __index = function(t, k)
				if k == "setopt_url" then return function(self, u) h._url = u end end
				if k == "setopt_useragent" then return function(self, ua) h._ua = ua end end
				if k == "setopt_writefunction" then return function(self, f) h._write = f end end
				if k == "perform" then
					return function(self)
						if h._post or not h._url then return nil, "only GET is supported headless" end
						local body, err = native.http_get(h._url, h._ua)
						if not body then return nil, err or "download failed" end
						if h._write then h._write(body) end
						return self
					end
				end
				if k == "close" then return noop end
				if k:match("^setopt_post") or k == "setopt_httppost" then
					return function(self, ...) h._post = true end
				end
				if k:match("^setopt") or k:match("^getinfo") then return noop end
				return nil
			end })
		end
		return M
	end
	local l_require = require
	function require(name)
		if absent[name] then
			return nil
		end
		return l_require(name)
	end
end

-- The lua CLI defines `arg`; Main.lua indexes it unguarded.
arg = arg or {}

-- ---------------------------------------------------------------------------
-- Callbacks / main object
-- ---------------------------------------------------------------------------
local callbackTable, mainObject = {}, nil
function runCallback(name, ...)
	if callbackTable[name] then
		return callbackTable[name](...)
	elseif mainObject and mainObject[name] then
		return mainObject[name](mainObject, ...)
	end
end
function SetCallback(name, func) callbackTable[name] = func end
function GetCallback(name) return callbackTable[name] end
function SetMainObject(obj) mainObject = obj end

-- ---------------------------------------------------------------------------
-- Console / logging
-- ---------------------------------------------------------------------------
function ConPrintf(fmt, ...)
	local ok, msg = pcall(string.format, tostring(fmt), ...)
	native.log("debug", ok and msg or tostring(fmt))
end
function ConPrintTable() end
function ConExecute() end
function ConClear() end
function print(...)
	local parts = {}
	for i = 1, select("#", ...) do
		parts[i] = tostring((select(i, ...)))
	end
	native.log("debug", table.concat(parts, "\t"))
end

-- ---------------------------------------------------------------------------
-- Rendering (no-ops) and images
-- ---------------------------------------------------------------------------
local imageHandleClass = {}
imageHandleClass.__index = imageHandleClass
function NewImageHandle() return setmetatable({}, imageHandleClass) end
function imageHandleClass:Load() self.valid = true end
function imageHandleClass:LoadArtRectangle() self.valid = true end
function imageHandleClass:LoadArtArcBand() self.valid = true end
function imageHandleClass:Unload() self.valid = false end
function imageHandleClass:IsValid() return self.valid == true end
function imageHandleClass:IsLoading() return false end
function imageHandleClass:SetLoadingPriority() end
function imageHandleClass:ImageSize() return 1, 1 end
function NewArtHandle() return { Size = function() return 1, 1 end } end

function RenderInit() end
function GetScreenSize() return 1920, 1080 end
function GetVirtualScreenSize() return 1920, 1080 end
function GetScreenScale() return 1 end
function GetDPIScaleOverridePercent() return 0 end
function SetDPIScaleOverridePercent() end
function SetClearColor() end
function SetDrawLayer() end
function GetDrawLayer() return 0 end
function SetViewport() end
function SetBlendMode() end
function SetDrawColor() end
function GetDrawColor() return 1, 1, 1, 1 end
function DrawImage() end
function DrawImageQuad() end
function DrawString() end
function DrawStringWidth(height, font, text) return 1 end
function DrawStringCursorIndex() return 0 end
function StripEscapes(text)
	local s = text:gsub("%^%d", ""):gsub("%^x%x%x%x%x%x%x", "")
	return s
end
function GetAsyncCount() return 0 end
function SetProfiling() end
function TakeScreenshot() end

-- ---------------------------------------------------------------------------
-- Input / window
-- ---------------------------------------------------------------------------
__window_title = ""
function SetWindowTitle(title) __window_title = title end
function GetCursorPos() return 0, 0 end
function SetCursorPos() end
function ShowCursor() end
function IsKeyDown() return false end
function SetForeground() end

-- Clipboard is owned by the UI; PoB's Copy/Paste go through these buffers.
__clipboard, __paste = nil, nil
function Copy(text) __clipboard = text end
function Paste()
	local t = __paste
	__paste = nil
	return t
end

-- ---------------------------------------------------------------------------
-- Compression
-- ---------------------------------------------------------------------------
function Deflate(data)
	local r = native.deflate(data)
	if r then return r end
	return nil, "deflate failed"
end
function Inflate(data)
	local r = native.inflate(data)
	if r then return r end
	return nil, "inflate failed"
end

-- ---------------------------------------------------------------------------
-- Time / process
-- ---------------------------------------------------------------------------
function GetTime() return native.time() end
function SpawnProcess() end
function OpenURL(url) __last_url = url end
function Restart() end
function Exit() end

-- ---------------------------------------------------------------------------
-- Filesystem
-- ---------------------------------------------------------------------------
function GetScriptPath() return root end
-- Differs from the script path on purpose: Main.lua treats equal paths as a
-- portable install and would put user data inside the resources directory.
function GetRuntimePath() return root .. "/runtime" end
function GetUserPath() return userDir end
function GetWorkDir() return root end
function SetWorkDir() end
function GetCloudProvider() return nil, nil, nil end
function MakeDir(path)
	local ok, err = native.make_dir(resolve(path))
	if ok then return true end
	return nil, err
end
function RemoveDir(path, recurse) native.remove_dir(resolve(path), recurse and true or false) end

local fileSearchClass = {}
fileSearchClass.__index = fileSearchClass
function fileSearchClass:NextFile()
	self.i = self.i + 1
	return self.i <= #self.list
end
function fileSearchClass:GetFileName() return self.list[self.i].name end
function fileSearchClass:GetFileSize() return self.list[self.i].size end
function fileSearchClass:GetFileModifiedTime() return self.list[self.i].mtime end
function NewFileSearch(spec, findDirectories)
	local list = native.file_search(resolve(spec), findDirectories and true or false)
	if not list then return nil end
	return setmetatable({ list = list, i = 1 }, fileSearchClass)
end

-- ---------------------------------------------------------------------------
-- Sub-scripts (PoB uses these for network I/O and update checks; none here)
-- ---------------------------------------------------------------------------
function LaunchSubScript() return nil end
function AbortSubScript() end
function IsSubScriptRunning() return false end

-- ---------------------------------------------------------------------------
-- Module loading
-- ---------------------------------------------------------------------------
function LoadModule(name, ...)
	if not name:match("%.lua$") then
		name = name .. ".lua"
	end
	local func, err = loadfile(name)
	if not func then
		error("LoadModule() error loading '" .. name .. "': " .. tostring(err))
	end
	return func(...)
end
function PLoadModule(name, ...)
	if not name:match("%.lua$") then
		name = name .. ".lua"
	end
	local func, err = loadfile(name)
	if not func then
		error("PLoadModule() error loading '" .. name .. "': " .. tostring(err))
	end
	return PCall(func, ...)
end
function PCall(func, ...)
	local ret = { xpcall(func, function(e) return debug.traceback(tostring(e), 2) end, ...) }
	if ret[1] then
		table.remove(ret, 1)
		return nil, unpack(ret)
	end
	return ret[2]
end

-- ---------------------------------------------------------------------------
-- Boot
-- ---------------------------------------------------------------------------
function __pob_boot()
	dofile("Launch.lua")
	runCallback("OnInit")
	if launch.promptMsg then
		error("PoB startup failed: " .. tostring(launch.promptMsg), 0)
	end
	-- Settings.xml may queue "reopen the last build"; the app manages builds itself.
	launch.main:SetMode("BUILD", false, "Unnamed build")
	runCallback("OnFrame")
	if launch.promptMsg then
		error("PoB startup failed: " .. tostring(launch.promptMsg), 0)
	end
end
