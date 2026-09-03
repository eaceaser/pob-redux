-- JSON-facing method table over the live Path of Building state.
--
-- Every method takes one table of params (or nil) and returns a JSON-friendly
-- table. Arrays must be marked with `array()` so empty ones serialise as [].
-- Methods raise Lua errors for bad input; Rust turns those into error strings.
--
-- The method set started from pob-mcp's lua/pob_bridge.lua (same author, MIT).

local native = __native
local array, null = native.array, native.null
local dkjson = require("dkjson")

local main = launch.main
local build = main.modes["BUILD"]

local function frame()
	runCallback("OnFrame")
end

-- Mark the build dirty and run one frame: PoB rebuilds calc output, the
-- sidebar stat list and dependent tab state inside OnFrame.
local function refresh()
	build.buildFlag = true
	build.modFlag = true
	frame()
end

local function ensureBuild()
	if not build or not build.calcsTab or not build.calcsTab.mainOutput then
		error("no build is loaded; call new_build, load_build_xml or load_build_code first", 0)
	end
end

local function isScalar(v)
	local t = type(v)
	return t == "number" or t == "string" or t == "boolean"
end

local function opt(v)
	if v == nil then return null end
	return v
end

local function strArray(t)
	local out = array({})
	for i, v in ipairs(t or {}) do out[i] = tostring(v) end
	return out
end

local function decodeCode(code)
	code = code:gsub("%s+", ""):gsub("-", "+"):gsub("_", "/")
	local ok, decoded = pcall(common.base64.decode, code)
	if not ok or not decoded then
		error("failed to base64-decode build code", 0)
	end
	local xml = Inflate(decoded)
	if not xml or xml == "" then
		error("build code did not inflate to XML", 0)
	end
	return xml
end

local function encodeCode(xml)
	local deflated = Deflate(xml)
	if not deflated or deflated == "" then
		error("deflate failed", 0)
	end
	return common.base64.encode(deflated):gsub("+", "-"):gsub("/", "_")
end

local M = {}

-- ---------------------------------------------------------------------------
-- Meta
-- ---------------------------------------------------------------------------

M.ping = function()
	return { ok = true, buildLoaded = (build.calcsTab ~= nil and build.calcsTab.mainOutput ~= nil) }
end

M.version = function()
	return {
		pobVersion = launch.versionNumber,
		pobBranch = opt(launch.versionBranch),
		treeVersions = strArray(treeVersionList),
		latestTreeVersion = latestTreeVersion,
		liveTargetVersion = liveTargetVersion,
		userPath = main.userPath,
		buildPath = main.buildPath,
	}
end

M.take_clipboard = function()
	local t = __clipboard
	__clipboard = nil
	return { text = opt(t) }
end

M.set_paste = function(p)
	__paste = p and p.text or nil
	return { ok = true }
end

M.refresh = function()
	ensureBuild()
	refresh()
	return { rev = build.outputRevision }
end

-- ---------------------------------------------------------------------------
-- Build lifecycle
-- ---------------------------------------------------------------------------

M.new_build = function(p)
	main:SetMode("BUILD", false, (p and p.name) or "Unnamed build")
	frame()
	build = main.modes["BUILD"]
	ensureBuild()
	return M.get_build()
end

M.load_build_xml = function(p)
	if not p or type(p.xml) ~= "string" or p.xml == "" then
		error("params.xml is required", 0)
	end
	main:SetMode("BUILD", false, p.name or "Imported build", p.xml)
	frame()
	build = main.modes["BUILD"]
	ensureBuild()
	return M.get_build()
end

M.load_build_code = function(p)
	if not p or type(p.code) ~= "string" or p.code == "" then
		error("params.code is required", 0)
	end
	return M.load_build_xml({ xml = decodeCode(p.code), name = p.name })
end

M.load_build_file = function(p)
	if not p or type(p.path) ~= "string" then
		error("params.path is required", 0)
	end
	local name = p.path:match("([^/\\]+)%.xml$") or p.path:match("([^/\\]+)$")
	main:SetMode("BUILD", p.path, name)
	frame()
	build = main.modes["BUILD"]
	ensureBuild()
	return M.get_build()
end

M.save_build_xml = function()
	ensureBuild()
	return { xml = build:SaveDB("code") }
end

M.save_build_code = function()
	ensureBuild()
	return { code = encodeCode(build:SaveDB("code")) }
end

M.save_build_file = function(p)
	ensureBuild()
	if p and p.path then
		build.dbFileName = p.path
		build.buildName = p.path:match("([^/\\]+)%.xml$") or build.buildName
	end
	if not build.dbFileName then
		error("build has no file name; pass params.path", 0)
	end
	build:SaveDBFile()
	return { ok = true, path = build.dbFileName }
end

M.get_build = function()
	ensureBuild()
	local spec = build.spec
	local out = build.calcsTab.mainOutput
	-- Same arithmetic as buildMode:EstimatePlayerProgress.
	local used, ascUsed, secAscUsed, socketsUsed, ws1, ws2 = spec:CountAllocNodes()
	local extra = out and out.ExtraPoints or 0
	local extraWs = out and out.PassivePointsToWeaponSetPoints or 0
	local points = {
		used = used - math.min(ws1 or 0, ws2 or 0),
		max = 99 + (build.maxWeaponSets or 0) + extra,
		ascUsed = ascUsed,
		ascMax = 8,
		weaponSet1Used = ws1 or 0,
		weaponSet2Used = ws2 or 0,
		weaponSetMax = (build.maxWeaponSets or 0) + extraWs,
		socketsUsed = socketsUsed or 0,
		requiredLevelText = opt(build.controls.pointDisplay and build.controls.pointDisplay.req),
		act = opt(build.Act),
	}
	return {
		points = points,
		name = build.buildName,
		file = opt(build.dbFileName),
		level = build.characterLevel,
		levelAuto = build.characterLevelAutoMode == true,
		classId = spec.curClassId,
		className = spec.curClassName,
		ascendClassId = spec.curAscendClassId,
		ascendClassName = opt(spec.curAscendClassName),
		mainSocketGroup = build.mainSocketGroup,
		treeVersion = spec.treeVersion,
		rev = build.outputRevision,
		unsaved = build.unsaved == true,
		title = __window_title,
		targetVersion = build.targetVersion,
	}
end

-- ---------------------------------------------------------------------------
-- Stats
-- ---------------------------------------------------------------------------

M.get_stats = function(p)
	ensureBuild()
	local output = build.calcsTab.mainOutput
	local stats = {}
	if p and p.fields then
		for _, key in ipairs(p.fields) do
			stats[key] = isScalar(output[key]) and output[key] or null
		end
	else
		for key, value in pairs(output) do
			if isScalar(value) then
				stats[key] = value
			end
		end
	end
	return { stats = stats, rev = build.outputRevision }
end

M.list_stat_keys = function()
	ensureBuild()
	local keys = array({})
	for key, value in pairs(build.calcsTab.mainOutput) do
		if isScalar(value) then
			keys[#keys + 1] = key
		end
	end
	table.sort(keys)
	return { keys = keys }
end

-- The sidebar exactly as PoB renders it: rows carry PoB colour escapes
-- (^7, ^xRRGGBB) which the UI parses. `h` is PoB's row height (6 = spacer).
-- Rows with `hasBreakdown` accept `sidebar_breakdown { rowIndex }`.
M.get_sidebar = function()
	ensureBuild()
	local rows = array({})
	for _, row in ipairs(build.controls.statBox.list) do
		rows[#rows + 1] = {
			h = row.height or 16,
			lhs = opt(row[1]),
			rhs = opt(row[2]),
			breakdown = opt(row.breakdown),
			hasBreakdown = (row.breakdown ~= nil or row.modNames ~= nil) and true or false,
			align = opt(row.align),
		}
	end
	local warnings = strArray(build.controls.warnings and build.controls.warnings.lines or {})
	return { rows = rows, warnings = warnings, rev = build.outputRevision }
end

-- Serialise the typed sections a CalcBreakdownControl built (TEXT lines,
-- TABLE with preformatted coloured cells, RADIUS marker).
local function breakdownSections(ctl)
	local sections = array({})
	for _, s in ipairs(ctl.sectionList or {}) do
		if s.type == "TEXT" then
			sections[#sections + 1] = { type = "text", size = s.textSize or 16, lines = strArray(s.lines) }
		elseif s.type == "TABLE" then
			local cols = array({})
			for _, c in ipairs(s.colList) do
				cols[#cols + 1] = { label = c.label or "", key = c.key, right = c.right == true }
			end
			local rows = array({})
			for _, r in ipairs(s.rowList) do
				local rr = {}
				for _, c in ipairs(s.colList) do
					local v = r[c.key]
					if isScalar(v) then rr[c.key] = tostring(v) end
				end
				rows[#rows + 1] = rr
			end
			sections[#sections + 1] = { type = "table", label = opt(s.label), footer = opt(s.footer), cols = cols, rows = rows }
		elseif s.type == "RADIUS" then
			sections[#sections + 1] = { type = "radius", radius = s.radius }
		end
	end
	return sections
end

-- Breakdown popup for one sidebar row, via Build's own breakdown control
-- (GetSidebarBreakdown → CalcBreakdownControl against mainEnv).
M.sidebar_breakdown = function(p)
	ensureBuild()
	local line = build.controls.statBox.list[tonumber(p and p.rowIndex) or -1]
	if not line then error("unknown sidebar row " .. tostring(p and p.rowIndex), 0) end
	if not line.breakdown and not line.modNames then
		return { sections = array({}), rev = build.outputRevision }
	end
	local displayData = build:GetSidebarBreakdown(line.breakdown, line.modNames, line.ignoredSections, line.actorName)
	local ctl = build.controls.breakdown
	ctl:SetBreakdownData(displayData, false, line.actorName == "minion" and "minion" or nil)
	local sections = breakdownSections(ctl)
	ctl:SetBreakdownData()
	return { sections = sections, rev = build.outputRevision }
end

-- The Calcs tab grid: PoB's own section controls with every cell's format
-- string resolved against the requested actor.
M.calc_sections = function(p)
	ensureBuild()
	local calcsTab = build.calcsTab
	local env = calcsTab.mainEnv
	local actor = (p and p.actor == "minion" and env.minion) or env.player
	local out = array({})
	for sIndex, section in ipairs(calcsTab.sectionList) do
		if section.subSection then
			local enabled = calcsTab:CheckFlag(section)
			local colour = section.colour
			local secOut = {
				index = sIndex,
				group = opt(section.group),
				colour = colour and string.format("#%02x%02x%02x", (colour[1] or 1) * 255, (colour[2] or 1) * 255, (colour[3] or 1) * 255) or null,
				enabled = enabled and true or false,
				subSections = array({}),
			}
			if enabled then
				for si, subSec in ipairs(section.subSection) do
					local sub = { index = si, label = subSec.label or "", rows = array({}) }
					local okExtra, extra = pcall(function()
						return subSec.data.extra and section:FormatStr(subSec.data.extra, actor)
					end)
					sub.extra = (okExtra and extra) and extra or null
					for ri, rowData in ipairs(subSec.data) do
						if calcsTab:CheckFlag(rowData) then
							local row = { index = ri, label = opt(rowData.label), cells = array({}) }
							for ci, colData in ipairs(rowData) do
								local text = ""
								if colData.control then
									text = "" -- injected UI controls (skill selectors) live in our own views
								elseif colData.format then
									local okF, formatted = pcall(section.FormatStr, section, colData.format, actor, colData)
									text = okF and formatted or "?"
								end
								row.cells[#row.cells + 1] = {
									index = ci,
									text = text,
									hasBreakdown = #colData > 0,
								}
							end
							sub.rows[#sub.rows + 1] = row
						end
					end
					secOut.subSections[#secOut.subSections + 1] = sub
				end
			end
			out[#out + 1] = secOut
		end
	end
	return { sections = out, rev = build.outputRevision }
end

-- Breakdown for one Calcs-grid cell (the cell's entry list drives
-- CalcBreakdownControl exactly as clicking it does in PoB).
M.calc_cell_breakdown = function(p)
	ensureBuild()
	local section = build.calcsTab.sectionList[tonumber(p and p.section) or -1]
	local subSec = section and section.subSection and section.subSection[tonumber(p.sub) or -1]
	local rowData = subSec and subSec.data[tonumber(p.row) or -1]
	local colData = rowData and rowData[tonumber(p.col) or -1]
	if not colData then error("unknown calc cell", 0) end
	local ctl = build.controls.breakdown
	ctl:SetBreakdownData(colData, false, p.actor == "minion" and "minion" or nil)
	local sections = breakdownSections(ctl)
	ctl:SetBreakdownData()
	return { sections = sections, rev = build.outputRevision }
end

-- Which config options PoB would show for the current build (each control's
-- `shown` closure evaluates ifSkill/ifFlag/ifCond/... against the live env).
M.config_visibility = function()
	ensureBuild()
	local vis = {}
	for var, control in pairs(build.configTab.varControls) do
		local ok, shown = pcall(control.IsShown, control)
		vis[var] = (ok and shown) and true or false
	end
	return { visibility = vis, rev = build.outputRevision }
end

M.set_level = function(p)
	ensureBuild()
	local level = tonumber(p and p.level)
	if not level then error("params.level is required", 0) end
	build.characterLevel = math.max(1, math.min(100, math.floor(level)))
	build.characterLevelAutoMode = false
	refresh()
	return M.get_build()
end

-- ---------------------------------------------------------------------------
-- Class / ascendancy
-- ---------------------------------------------------------------------------

M.list_classes = function()
	ensureBuild()
	local classes = array({})
	for classId, classData in pairs(build.spec.tree.classes) do
		local ascendancies = array({})
		for ascendId, ascendData in pairs(classData.classes or {}) do
			if ascendId ~= 0 then
				ascendancies[#ascendancies + 1] = { id = ascendId, name = ascendData.name }
			end
		end
		table.sort(ascendancies, function(a, b) return a.id < b.id end)
		classes[#classes + 1] = { id = classId, name = classData.name, ascendancies = ascendancies }
	end
	table.sort(classes, function(a, b) return a.id < b.id end)
	return { classes = classes }
end

M.select_class = function(p)
	ensureBuild()
	if not p then error("params.classId or params.ascendClassId is required", 0) end
	-- SelectClass mutates before validating; snapshot so a bad id never leaves
	-- a half-applied state.
	local snapshot = build:SaveDB("snapshot")
	local ok, err = pcall(function()
		if p.classId ~= nil and tonumber(p.classId) ~= build.spec.curClassId then
			build.spec:SelectClass(tonumber(p.classId))
		end
		if p.ascendClassId ~= nil then
			build.spec:SelectAscendClass(tonumber(p.ascendClassId))
		end
	end)
	if not ok then
		M.load_build_xml({ xml = snapshot, name = build.buildName })
		error("select_class failed and was rolled back: " .. tostring(err), 0)
	end
	build.spec:AddUndoState()
	refresh()
	return M.get_build()
end

-- ---------------------------------------------------------------------------
-- Passive tree
-- ---------------------------------------------------------------------------

local function requireNode(p)
	local id = tonumber(p and p.id)
	if not id then error("params.id (node id) is required", 0) end
	local node = build.spec.nodes[id]
	if not node then error("unknown node id " .. tostring(id), 0) end
	return node
end

local function nodeSummary(id, node)
	return {
		id = id,
		name = opt(node.dn or node.name),
		type = opt(node.type),
		stats = strArray(node.sd),
		allocated = node.alloc == true,
		ascendancyName = opt(node.ascendancyName),
		pathCost = node.path and #node.path or null,
		reminder = node.reminderText and strArray(node.reminderText) or null,
	}
end

M.get_tree_state = function()
	ensureBuild()
	local spec = build.spec
	local alloc = array({})
	-- Nodes whose content differs from tree.json: attribute nodes switched to
	-- Str/Dex/Int, and `isSwitchable` ascendancy variants (e.g. Abyssal Lich).
	-- The renderer overlays these onto its static model.
	local overrides = {}
	local function override(id, node)
		overrides[tostring(id)] = {
			name = opt(node.dn),
			icon = opt(node.icon),
			stats = strArray(node.sd),
			overlay = node.overlay and node.overlay.alloc and {
				alloc = node.overlay.alloc,
				path = node.overlay.path,
				unalloc = node.overlay.unalloc,
			} or null,
		}
	end
	for id, node in pairs(spec.nodes) do
		local tnode = spec.tree.nodes[id]
		if node.alloc then
			alloc[#alloc + 1] = id
			if node.isAttribute and node.dn and node.dn ~= "Attribute" then
				override(id, node)
			end
		end
		if tnode and tnode.isSwitchable then
			override(id, node)
		end
	end
	table.sort(alloc)
	local sockets = array({})
	for nodeId in pairs(spec.tree.sockets) do
		local ok, _, jewel = pcall(build.itemsTab.GetSocketAndJewelForNodeID, build.itemsTab, nodeId)
		if ok and jewel then
			sockets[#sockets + 1] = {
				nodeId = nodeId,
				itemId = jewel.id,
				name = jewel.name,
				title = opt(jewel.title),
				baseName = opt(jewel.baseName),
				rarity = opt(jewel.rarity),
				radiusIndex = opt(jewel.jewelRadiusIndex),
				radiusLabel = opt(jewel.jewelRadiusLabel),
			}
		end
	end
	return {
		treeVersion = spec.treeVersion,
		classId = spec.curClassId,
		className = spec.curClassName,
		ascendClassId = spec.curAscendClassId,
		ascendClassName = opt(spec.curAscendClassName),
		allocatedNodes = alloc,
		allocatedNodeCount = #alloc,
		pointsUsed = spec:CountAllocNodes(),
		overrides = overrides,
		sockets = sockets,
		rev = build.outputRevision,
	}
end

-- Allocated node ids of any spec, without switching to it (compare overlay).
M.spec_alloc = function(p)
	ensureBuild()
	local spec = build.treeTab.specList[tonumber(p and p.index) or -1]
	if not spec then error("unknown spec index " .. tostring(p and p.index), 0) end
	local ids = array({})
	for id, node in pairs(spec.nodes) do
		if node.alloc then ids[#ids + 1] = id end
	end
	table.sort(ids)
	return { index = tonumber(p.index), allocatedNodes = ids }
end

-- Allocate a traced path (shift-hover in the tree). `ids` must run from the
-- tree side to the target; PoB's AllocNode takes it as the alternate path.
M.alloc_trace = function(p)
	ensureBuild()
	if not p or type(p.ids) ~= "table" or #p.ids == 0 then error("params.ids is required", 0) end
	local spec = build.spec
	local nodes = {}
	for i, id in ipairs(p.ids) do
		local n = spec.nodes[tonumber(id)]
		if not n then error("unknown node id " .. tostring(id), 0) end
		nodes[i] = n
	end
	local target = nodes[#nodes]
	if not target.path then error("target node cannot be reached", 0) end
	spec:AllocNode(target, nodes)
	spec:AddUndoState()
	refresh()
	return M.get_tree_state()
end

-- Node ids inside one jewel radius of a socket (tree-space precomputed map).
M.socket_nodes = function(p)
	ensureBuild()
	local id = tonumber(p and p.id)
	local ri = tonumber(p and p.radiusIndex)
	local socket = build.spec.tree.sockets[id or -1]
	if not socket then error("unknown socket " .. tostring(p and p.id), 0) end
	local ids = array({})
	local map = socket.nodesInRadius and ri and socket.nodesInRadius[ri]
	if map then
		for nid in pairs(map) do ids[#ids + 1] = nid end
	end
	table.sort(ids)
	return { id = id, radiusIndex = opt(ri), nodes = ids }
end

-- Hover preview: the allocation path for an unallocated node, or the nodes
-- that would be removed with an allocated one (PassiveTreeView's hoverPath /
-- hoverDep).
M.node_hover = function(p)
	ensureBuild()
	local node = requireNode(p)
	local out = { id = node.id, allocated = node.alloc == true, path = array({}), depends = array({}) }
	if node.alloc then
		for i, n in ipairs(node.depends or {}) do out.depends[i] = n.id end
	elseif node.path then
		local ok, path = pcall(build.spec.GetEffectiveAllocationPath, build.spec, node)
		path = (ok and path) or node.path or {}
		for i, n in ipairs(path) do out.path[i] = n.id end
		out.cost = #path
	end
	return out
end

-- Left-click on a node, following PassiveTreeView:Draw's click handling:
-- deallocate, switch attribute, switch ascendancy (same class directly,
-- cross-class after confirmation), or allocate along the path.
-- params: { id, attribute = 1|2|3 (Str/Dex/Int), confirm = "reset"|"connect" }
M.tree_click = function(p)
	ensureBuild()
	local node = requireNode(p)
	local spec = build.spec
	local attr = tonumber(p.attribute)

	if node.alloc then
		if node.isAttribute and attr then
			spec.attributeIndex = attr
			spec:SwitchAttributeNode(node.id, attr)
			spec:BuildAllDependsAndPaths()
		elseif node.isAttribute then
			spec.hashOverrides[node.id] = nil
			spec:DeallocNode(node)
		else
			spec:DeallocNode(node)
		end
		spec:AddUndoState()
		refresh()
		return M.get_tree_state()
	end

	if node.ascendancyName then
		local cur = spec.curAscendClass and (spec.curAscendClass.replace or spec.curAscendClassBaseName)
		local different = spec.curAscendClassId == 0 or node.ascendancyName ~= cur
		if different and not (spec.curSecondaryAscendClass and node.ascendancyName == spec.curSecondaryAscendClass.id) then
			local targetAscendClassId
			for ascendClassId, ascendClass in pairs(spec.curClass.classes) do
				if ascendClass.id == node.ascendancyName then targetAscendClassId = ascendClassId break end
			end
			if targetAscendClassId then
				spec:SelectAscendClass(targetAscendClassId)
			else
				local targetBaseClassId
				for classId, classData in pairs(spec.tree.classes) do
					for ascendClassId, ascendClass in pairs(classData.classes) do
						if ascendClass.id == node.ascendancyName then
							targetBaseClassId, targetAscendClassId = classId, ascendClassId
							break
						end
					end
					if targetBaseClassId then break end
				end
				if targetBaseClassId then
					local used = spec:CountAllocNodes()
					if used == 0 or spec:IsClassConnected(targetBaseClassId) or p.confirm == "reset" then
						spec:SelectClass(targetBaseClassId)
						spec:SelectAscendClass(targetAscendClassId)
					elseif p.confirm == "connect" then
						if not spec:ConnectToClass(targetBaseClassId) then
							error("no path connects the tree to that class", 0)
						end
						spec:SelectClass(targetBaseClassId)
						spec:SelectAscendClass(targetAscendClassId)
					else
						return {
							needsConfirm = "class_change",
							className = spec.tree.classes[targetBaseClassId].name,
							ascendClassName = node.ascendancyName,
							id = node.id,
						}
					end
				end
			end
			spec:SetWindowTitleWithBuildClass()
		end
	end

	local target = spec.nodes[node.id]
	if target and target.path then
		if target.isAttribute then
			if not attr then
				return { needsAttribute = true, id = target.id }
			end
			spec.attributeIndex = attr
			spec:SwitchAttributeNode(target.id, attr)
			target = spec.nodes[node.id]
		end
		spec:AllocNode(target)
	end
	spec:AddUndoState()
	refresh()
	return M.get_tree_state()
end

M.switch_attribute = function(p)
	ensureBuild()
	local node = requireNode(p)
	local attr = tonumber(p.attribute)
	if not node.isAttribute or not attr then error("params.id must be an attribute node and params.attribute 1..3", 0) end
	build.spec.attributeIndex = attr
	build.spec:SwitchAttributeNode(node.id, attr)
	build.spec:BuildAllDependsAndPaths()
	build.spec:AddUndoState()
	refresh()
	return M.get_tree_state()
end

M.export_tree_url = function()
	ensureBuild()
	return { url = build.spec:EncodeURL("https://www.pathofexile.com/passive-skill-tree/") }
end

M.import_tree_url = function(p)
	ensureBuild()
	if not p or type(p.url) ~= "string" or p.url == "" then error("params.url is required", 0) end
	local err = build.spec:DecodeURL(p.url)
	if err then error(err, 0) end
	build.spec:AddUndoState()
	refresh()
	return M.get_tree_state()
end

-- Stats selectable for the node power heat map (Data.lua powerStatList).
M.power_stats = function()
	local out = array({})
	for _, s in ipairs(data.powerStatList) do
		if not s.ignoreForNodes then
			out[#out + 1] = { stat = opt(s.stat), label = s.label }
		end
	end
	return { stats = out }
end

local function findPowerStat(stat)
	if stat then
		for _, s in ipairs(data.powerStatList) do
			if s.stat == stat then return s end
		end
	end
	return data.powerStatList[1]
end

local powerProgress = 0
local powerStarted = 0

-- Chunked node-power build for a responsive UI: start, then step until done,
-- then result. Each step resumes CalcsTab's PowerBuilder coroutine (which
-- yields roughly every 100 ms of work) until the time budget is spent.
-- params: { stat = "Life"|nil (nil = Offence/Defence), maxDepth = 10|nil }
M.tree_power_start = function(p)
	ensureBuild()
	p = p or {}
	local calcsTab = build.calcsTab
	calcsTab.powerStat = findPowerStat(p.stat)
	calcsTab.nodePowerMaxDepth = tonumber(p.maxDepth)
	calcsTab.powerBuildFlag = true
	powerProgress = 0
	powerStarted = GetTime()
	build.powerBuilderProgressCallback = function(percent) powerProgress = percent or 0 end
	calcsTab:BuildPower()
	return { done = calcsTab.powerBuilder == nil, progress = powerProgress }
end

M.tree_power_step = function(p)
	ensureBuild()
	local calcsTab = build.calcsTab
	local budget = tonumber(p and p.budgetMs) or 150
	local t0 = GetTime()
	while calcsTab.powerBuilder and GetTime() - t0 < budget do
		calcsTab:BuildPower()
	end
	return { done = calcsTab.powerBuilder == nil, progress = powerProgress }
end

local function powerResult()
	local calcsTab = build.calcsTab
	local powerStat = calcsTab.powerStat or data.powerStatList[1]
	local nodes = {}
	for id, node in pairs(build.spec.nodes) do
		local pw = node.power
		if pw and (pw.singleStat or pw.offence or pw.defence) then
			nodes[tostring(id)] = {
				s = opt(pw.singleStat),
				o = opt(pw.offence),
				d = opt(pw.defence),
				p = opt(pw.pathPower),
				dist = opt(pw.distance),
			}
		end
	end
	local report = array({})
	local ok, list = pcall(build.treeTab.BuildPowerReportList, build.treeTab, powerStat)
	if ok and type(list) == "table" then
		for i, r in ipairs(list) do
			report[i] = {
				id = r.id,
				name = r.name,
				power = r.power,
				powerStr = r.powerStr,
				pathPower = r.pathPower,
				pathPowerStr = r.pathPowerStr,
				allocated = r.allocated == true,
				pathDist = opt(r.pathDist),
				type = opt(r.type),
			}
		end
	end
	local max = calcsTab.powerMax or {}
	return {
		stat = opt(powerStat.stat),
		label = powerStat.label,
		nodes = nodes,
		max = {
			singleStat = max.singleStat or 0,
			offence = max.offence or 0,
			defence = max.defence or 0,
			offencePerPoint = max.offencePerPoint or 0,
			defencePerPoint = max.defencePerPoint or 0,
		},
		report = report,
		ms = GetTime() - powerStarted,
		rev = build.outputRevision,
	}
end

M.tree_power_result = function()
	ensureBuild()
	return powerResult()
end

-- Blocking convenience for the CLI.
M.tree_power = function(p)
	local r = M.tree_power_start(p)
	while not r.done do
		r = M.tree_power_step({ budgetMs = 1000 })
	end
	return powerResult()
end

-- ---------------------------------------------------------------------------
-- Parallel node power. The main engine lists the eligible nodes
-- (tree_power_partition), pooled worker engines score their share with the
-- same calc PowerBuilder runs (score_nodes), and the scores are written back
-- into node.power (tree_power_apply) so tree_power_result and the power
-- report are unchanged.
-- ---------------------------------------------------------------------------

local function num(v)
	if type(v) == "number" then return v end
	return nil
end

M.tree_power_partition = function(p)
	ensureBuild()
	p = p or {}
	local calcsTab = build.calcsTab
	calcsTab.powerStat = findPowerStat(p.stat)
	calcsTab.nodePowerMaxDepth = tonumber(p.maxDepth)
	powerStarted = GetTime()
	local grantedPassives = calcsTab.mainEnv and calcsTab.mainEnv.grantedPassives or {}
	local list = {}
	for nodeId, node in pairs(build.spec.nodes) do
		if node.power then wipeTable(node.power) else node.power = {} end
		if node.modKey ~= "" and not grantedPassives[nodeId] then
			local hidden = false
			if node.unlockConstraint then
				for _, unlockNodeId in ipairs(node.unlockConstraint.nodes) do
					local unlockNode = build.spec.nodes[unlockNodeId]
					if unlockNode and unlockNode.ascendancyName and not unlockNode.alloc then
						hidden = true
						break
					end
				end
			end
			if not hidden then
				local dist = node.pathDist or 1000
				for _, leap in ipairs(node.intuitiveLeapLikesAffecting or {}) do
					if leap.alloc then dist = math.max(math.min(leap.pathDist or 1000, dist), 1) end
				end
				node.power.distance = dist
				if (not calcsTab.nodePowerMaxDepth) or dist <= calcsTab.nodePowerMaxDepth then
					list[#list + 1] = { id = nodeId, dist = dist, modKey = node.modKey }
				end
			end
		end
	end
	-- identical mod keys share one calc in PowerBuilder's cache; keep them
	-- adjacent so a contiguous slice lands on one worker
	table.sort(list, function(a, b)
		if a.modKey ~= b.modKey then return a.modKey < b.modKey end
		return a.id < b.id
	end)
	-- shortest paths can tie; ship this engine's choice so workers score the
	-- same path PowerBuilder would here (pathPower depends on it)
	local ids, dists, paths = array({}), array({}), array({})
	for i, e in ipairs(list) do
		ids[i] = e.id
		dists[i] = e.dist
		local node = build.spec.nodes[e.id]
		local pathIds = array({})
		if node then
			local src = (not node.alloc) and node.path or node.depends
			for _, pn in pairs(src or {}) do
				if type(pn) == "table" and pn.id then pathIds[#pathIds + 1] = pn.id end
			end
		end
		paths[i] = pathIds
	end
	return { ids = ids, dists = dists, paths = paths, stat = opt(calcsTab.powerStat.stat), rev = build.outputRevision }
end

-- Worker side: PowerBuilder's per-node evaluation for a subset of nodes.
M.score_nodes = function(p)
	ensureBuild()
	local calcsTab = build.calcsTab
	local powerStat = findPowerStat(p and p.stat)
	local useFullDPS = powerStat and powerStat.stat == "FullDPS"
	local calcFunc, calcBase = calcsTab:GetMiscCalculator()
	local cache = {}
	local out = array({})
	-- the main engine's path for each node, when supplied; else this state's
	local function pathSet(i, fallback)
		local given = p.paths and p.paths[i]
		if type(given) == "table" and #given > 0 then
			local set = {}
			for _, pid in ipairs(given) do
				local pn = build.spec.nodes[pid]
				if pn then set[pn] = true end
			end
			return set
		end
		local set = {}
		for _, pn in pairs(fallback or {}) do set[pn] = true end
		return set
	end
	for i, id in ipairs(p.ids or {}) do
		local node = build.spec.nodes[id]
		if node then
			local dist = num(p.dists and p.dists[i]) or node.pathDist or 1000
			local r = { id = id, dist = dist }
			if not node.alloc then
				if not cache[node.modKey] then
					cache[node.modKey] = calcFunc({ addNodes = { [node] = true } }, useFullDPS)
				end
				local output = cache[node.modKey]
				if powerStat and powerStat.stat and not powerStat.ignoreForNodes then
					r.s = calcsTab:CalculatePowerStat(powerStat, output, calcBase)
					if node.path and not node.ascendancyName then
						r.rank = true
						r.p = r.s
						if dist > 1 then
							r.p = calcsTab:CalculatePowerStat(powerStat, calcFunc({ addNodes = pathSet(i, node.path) }, useFullDPS), calcBase)
						end
					end
				elseif not powerStat or not powerStat.ignoreForNodes then
					r.o, r.d = calcsTab:CalculateCombinedOffDefStat(output, calcBase)
					r.s = r.o
					if node.path and not node.ascendancyName then r.rank = true end
				end
			else
				local key = node.modKey .. "_remove"
				if not cache[key] then
					cache[key] = calcFunc({ removeNodes = { [node] = true } }, useFullDPS)
				end
				local output = cache[key]
				if powerStat and powerStat.stat and not powerStat.ignoreForNodes then
					r.s = calcsTab:CalculatePowerStat(powerStat, output, calcBase)
					if node.depends and not node.ascendancyName then
						r.p = r.s
						if #node.depends > 1 then
							r.p = calcsTab:CalculatePowerStat(powerStat, calcFunc({ removeNodes = pathSet(i, node.depends) }, useFullDPS), calcBase)
						end
					end
				end
			end
			out[#out + 1] = r
		end
	end
	return { nodes = out }
end

M.tree_power_apply = function(p)
	ensureBuild()
	local calcsTab = build.calcsTab
	local max = { singleStat = 0, offence = 0, defence = 0, offencePerPoint = 0, defencePerPoint = 0 }
	for _, r in ipairs(p and p.nodes or {}) do
		local node = build.spec.nodes[r.id]
		if node then
			node.power = node.power or {}
			node.power.singleStat = num(r.s)
			node.power.offence = num(r.o)
			node.power.defence = num(r.d)
			node.power.pathPower = num(r.p)
			node.power.distance = num(r.dist) or node.power.distance
			if r.rank == true then
				if node.power.singleStat then
					max.singleStat = math.max(max.singleStat, node.power.singleStat)
				end
				if node.power.offence then
					local d = node.power.distance or 1
					max.offence = math.max(max.offence, node.power.offence)
					max.defence = math.max(max.defence, node.power.defence or 0)
					max.offencePerPoint = math.max(max.offencePerPoint, node.power.offence / d)
					max.defencePerPoint = math.max(max.defencePerPoint, (node.power.defence or 0) / d)
				end
			end
		end
	end
	calcsTab.powerMax = max
	calcsTab.powerBuilderInitialized = true
	calcsTab.powerBuildFlag = false
	calcsTab.powerBuilder = nil
	return powerResult()
end

-- Jewel radii for the socket hover rings (Data.lua jewelRadii, tree units).
M.jewel_radii = function()
	local out = array({})
	local mult = data.gameConstants and data.gameConstants["PassiveTreeJewelDistanceMultiplier"] or 1
	for i, r in ipairs(data.jewelRadius or {}) do
		out[i] = { inner = r.inner * mult, outer = r.outer * mult, color = r.col, label = r.label }
	end
	return { radii = out }
end

M.node_info = function(p)
	ensureBuild()
	local node = requireNode(p)
	local info = nodeSummary(node.id, node)
	local mods = array({})
	if node.modList then
		for _, mod in ipairs(node.modList) do
			mods[#mods + 1] = { name = mod.name, type = mod.type, value = isScalar(mod.value) and mod.value or tostring(mod.value) }
		end
	end
	info.mods = mods
	info.icon = opt(node.icon)
	return info
end

M.node_path = function(p)
	ensureBuild()
	local node = requireNode(p)
	local ids = array({})
	for i, n in ipairs(node.path or {}) do ids[i] = n.id end
	return { id = node.id, path = ids, cost = #ids, allocated = node.alloc == true }
end

-- Objectives for path_plan. Matched against a node's stat lines, so a route can
-- be judged by what it grants on the way rather than by length alone. Weights
-- separate what a category is really about from what merely correlates.
local PATH_OBJECTIVES = {
	defence = {
		{ "maximum life", 10 }, { "maximum energy shield", 10 }, { "%% increased life", 8 },
		{ "resistance", 8 }, { "armour", 6 }, { "evasion", 6 }, { "block", 6 },
		{ "suppress", 6 }, { "life regeneration", 4 }, { "recoup", 3 }, { "reduced damage taken", 10 },
		{ "stun threshold", 2 }, { "ailment", 2 },
	},
	damage = {
		{ "increased damage", 10 }, { "critical", 8 }, { "penetration", 8 },
		{ "attack speed", 7 }, { "cast speed", 7 }, { "damage over time", 7 },
		{ "accuracy", 4 }, { "%% increased.*damage", 8 }, { "added.*damage", 6 },
	},
	speed = {
		{ "movement speed", 10 }, { "attack speed", 6 }, { "cast speed", 6 },
	},
	attributes = {
		{ "strength", 8 }, { "dexterity", 8 }, { "intelligence", 8 }, { "all attributes", 12 },
	},
}

-- How much a node is worth for an objective. `objective` is a known category or
-- any substring to match against the node's stat lines.
local function nodeValue(node, objective)
	if not objective or objective == "short" then return 0 end
	local lines = node.sd
	if not lines or #lines == 0 then return 0 end
	local rules = PATH_OBJECTIVES[objective]
	local score = 0
	for _, line in ipairs(lines) do
		local text = line:lower()
		if rules then
			for _, rule in ipairs(rules) do
				if text:find(rule[1]) then score = score + rule[2] end
			end
		elseif text:find(objective:lower(), 1, true) then
			score = score + 10
		end
	end
	-- Notables carry the meaningful passives; keep them ahead of small nodes
	-- that happen to mention the same words.
	if score > 0 and node.type == "Notable" then score = score * 2 end
	return score
end

--- Cheapest route from the allocated tree to a node, preferring routes whose
--- intermediate nodes serve `objective`.
---
--- PoB's own `node.path` is shortest by node count and indifferent to what it
--- passes through. This walks the graph itself so a caller can ask for the
--- shortest route that also picks up life or damage on the way, and can spend
--- up to `max_extra` further points when that buys enough.
---
--- best[len][id] = highest objective score reachable at `id` using exactly
--- `len` unallocated nodes, so length stays a hard budget while score decides
--- between routes that cost the same.
M.path_plan = function(p)
	ensureBuild()
	local node = requireNode(p)
	local spec = build.spec
	local objective = p.objective and tostring(p.objective) or "short"
	local maxExtra = math.max(0, math.min(tonumber(p.max_extra) or 0, 12))

	if node.alloc then
		return { id = node.id, name = opt(node.dn or node.name), already_allocated = true,
			path = array({}), points = 0, shortest = 0, extra = 0, score = 0, attribute_nodes = 0 }
	end
	if not node.path then error("node " .. node.id .. " cannot be reached from the current tree", 0) end

	local shortest = #node.path
	local budget = shortest + maxExtra

	-- best[len] maps node id -> { score, prev }. Length 0 is the allocated tree.
	local best = { [0] = {} }
	for id in pairs(spec.allocNodes) do best[0][id] = { score = 0, prev = nil } end

	for len = 1, budget do
		best[len] = {}
		for id, entry in pairs(best[len - 1]) do
			local cur = spec.nodes[id]
			for _, other in ipairs(cur and cur.linked or {}) do
				-- Ascendancy and class-start nodes are not walkable filler.
				if not other.alloc and other.id and not other.isAscendancyStart and other.type ~= "ClassStart" then
					local score = entry.score + nodeValue(other, objective)
					local prevBest = best[len][other.id]
					if not prevBest or score > prevBest.score then
						best[len][other.id] = { score = score, prev = id, at = len - 1 }
					end
				end
			end
		end
	end

	-- Shortest wins; score only separates routes of equal length, unless the
	-- caller allowed extra points, in which case take the best score within it.
	local pickLen, pickScore
	for len = 1, budget do
		local hit = best[len] and best[len][node.id]
		if hit and (pickLen == nil or hit.score > pickScore) then
			pickLen, pickScore = len, hit.score
		end
	end
	if not pickLen then error("node " .. node.id .. " is unreachable within " .. budget .. " points", 0) end

	local ids, len, id = {}, pickLen, node.id
	while len > 0 and id do
		table.insert(ids, 1, id)
		local step = best[len][id]
		id, len = step and step.prev, len - 1
	end

	local steps, attrCount = array({}), 0
	for i, nid in ipairs(ids) do
		local n = spec.nodes[nid]
		steps[i] = nodeSummary(nid, n)
		steps[i].value = nodeValue(n, objective)
		steps[i].is_attribute = n.isAttribute == true
		if n.isAttribute then attrCount = attrCount + 1 end
	end

	return {
		id = node.id,
		name = opt(node.dn or node.name),
		objective = objective,
		path = steps,
		points = pickLen,
		shortest = shortest,
		extra = pickLen - shortest,
		score = pickScore,
		attribute_nodes = attrCount,
		attribute_index = spec.attributeIndex,
	}
end

--- What the tree's switchable attribute nodes grant: 1 Str, 2 Dex, 3 Int.
---
--- `attributeIndex` is the default applied to nodes allocated from now on, so
--- set this before pathing. Nodes already allocated keep whatever they were
--- given until `apply_to_allocated` rewrites them.
M.set_attribute_choice = function(p)
	ensureBuild()
	local attr = tonumber(p and p.attribute)
	if not attr or attr < 1 or attr > 3 then
		error("params.attribute must be 1 (Strength), 2 (Dexterity) or 3 (Intelligence)", 0)
	end
	local spec = build.spec
	spec.attributeIndex = attr
	local switched = 0
	if p.apply_to_allocated then
		for id, n in pairs(spec.allocNodes) do
			if n.isAttribute then
				spec:SwitchAttributeNode(id, attr)
				switched = switched + 1
			end
		end
	end
	spec:BuildAllDependsAndPaths()
	spec:AddUndoState()
	refresh()
	local state = M.get_tree_state()
	state.attribute_index = attr
	state.switched = switched
	return state
end

M.search_tree = function(p)
	ensureBuild()
	p = p or {}
	local query = p.query and tostring(p.query):lower() or nil
	local limit = tonumber(p.limit) or 200
	local results = array({})
	for id, node in pairs(build.spec.nodes) do
		local include = true
		if p.type and node.type ~= p.type then include = false end
		if include and p.ascendancyName ~= nil then
			if p.ascendancyName == false or p.ascendancyName == "" then
				include = node.ascendancyName == nil
			else
				include = node.ascendancyName == p.ascendancyName
			end
		end
		if include and query and query ~= "" then
			local hay = (node.dn or node.name or ""):lower()
			if not hay:find(query, 1, true) then
				include = false
				for _, line in ipairs(node.sd or {}) do
					if line:lower():find(query, 1, true) then include = true break end
				end
			end
		end
		if include then
			results[#results + 1] = nodeSummary(id, node)
			if #results >= limit then break end
		end
	end
	table.sort(results, function(a, b) return a.id < b.id end)
	return { nodes = results, truncated = (#results >= limit) }
end

M.alloc_node = function(p)
	ensureBuild()
	local node = requireNode(p)
	build.spec:AllocNode(node)
	build.spec:AddUndoState()
	refresh()
	return M.get_tree_state()
end

M.dealloc_node = function(p)
	ensureBuild()
	local node = requireNode(p)
	build.spec:DeallocNode(node)
	build.spec:AddUndoState()
	refresh()
	return M.get_tree_state()
end

M.tree_undo = function()
	ensureBuild()
	build.spec:Undo()
	refresh()
	return M.get_tree_state()
end

M.tree_redo = function()
	ensureBuild()
	build.spec:Redo()
	refresh()
	return M.get_tree_state()
end

M.reset_tree = function()
	ensureBuild()
	build.spec:ResetNodes()
	build.spec:AddUndoState()
	refresh()
	return M.get_tree_state()
end

-- Convert the active tree (or every tree) to the latest tree version. PoB
-- inserts the converted copy after the original; passives that no longer
-- exist are dropped.
M.convert_tree = function(p)
	ensureBuild()
	local target = (p and p.version) or latestTreeVersion
	if not treeVersions[target] then error("unknown tree version " .. tostring(target), 0) end
	if p and p.all then
		build.treeTab:ConvertAllToVersion(target)
	else
		build.treeTab:ConvertToVersion(target, p and p.replace == true, false)
	end
	build.modFlag = true
	refresh()
	return M.list_specs()
end

M.list_specs = function()
	ensureBuild()
	local specs = array({})
	for index, spec in ipairs(build.treeTab.specList) do
		local count = 0
		for _, node in pairs(spec.nodes) do
			if node.alloc then count = count + 1 end
		end
		local asc = spec.curAscendClassName
		specs[#specs + 1] = {
			index = index,
			title = spec.title or "Default",
			className = spec.curClassName,
			ascendClassName = (asc and asc ~= "None") and asc or null,
			allocatedNodeCount = count,
			treeVersion = spec.treeVersion,
			active = (index == build.treeTab.activeSpec),
		}
	end
	return { specs = specs, activeSpec = build.treeTab.activeSpec }
end

M.select_spec = function(p)
	ensureBuild()
	local index = tonumber(p and p.index)
	if not index or not build.treeTab.specList[index] then error("unknown spec index", 0) end
	build.treeTab:SetActiveSpec(index)
	refresh()
	return M.list_specs()
end

M.create_spec = function(p)
	ensureBuild()
	local spec = new("PassiveSpec", build, build.spec.treeVersion)
	spec.title = (p and p.title) or "New Tree"
	spec:SelectClass(build.spec.curClassId)
	spec:SelectAscendClass(build.spec.curAscendClassId)
	table.insert(build.treeTab.specList, spec)
	build.treeTab:SetActiveSpec(#build.treeTab.specList)
	refresh()
	return M.list_specs()
end

M.copy_spec = function(p)
	ensureBuild()
	local src = tonumber(p and p.index) or build.treeTab.activeSpec
	if not build.treeTab.specList[src] then error("unknown spec index", 0) end
	build.treeTab:CopyTree(src, p and p.title)
	build.treeTab:SetActiveSpec(#build.treeTab.specList)
	refresh()
	return M.list_specs()
end

M.rename_spec = function(p)
	ensureBuild()
	local spec = build.treeTab.specList[tonumber(p and p.index) or -1]
	if not spec then error("unknown spec index", 0) end
	if not p.title then error("params.title is required", 0) end
	spec.title = p.title
	build.modFlag = true
	return M.list_specs()
end

M.delete_spec = function(p)
	ensureBuild()
	local index = tonumber(p and p.index)
	if not index or not build.treeTab.specList[index] then error("unknown spec index", 0) end
	if #build.treeTab.specList <= 1 then error("cannot delete the only tree", 0) end
	table.remove(build.treeTab.specList, index)
	if index == build.treeTab.activeSpec or build.treeTab.activeSpec > #build.treeTab.specList then
		build.treeTab:SetActiveSpec(math.max(1, index - 1))
	end
	refresh()
	return M.list_specs()
end

-- ---------------------------------------------------------------------------
-- Items
-- ---------------------------------------------------------------------------

local function itemSummary(item)
	return {
		id = item.id,
		name = item.name,
		title = opt(item.title),
		baseName = opt(item.baseName),
		type = opt(item.type),
		rarity = opt(item.rarity),
		raw = item.raw,
		corrupted = item.corrupted == true,
		quality = opt(item.quality),
		itemLevel = opt(item.itemLevel),
		requirements = item.requirements and {
			level = opt(item.requirements.level),
			str = opt(item.requirements.str),
			dex = opt(item.requirements.dex),
			int = opt(item.requirements.int),
		} or null,
	}
end

M.list_slots = function()
	ensureBuild()
	-- PoB flags unallocated tree jewel sockets inactive (and relabels the
	-- active ones "Socket #n") only from its draw path; do it here instead
	pcall(build.itemsTab.UpdateSockets, build.itemsTab)
	local slots = array({})
	for _, slot in ipairs(build.itemsTab.orderedSlots) do
		local item = slot.selItemId and slot.selItemId ~= 0 and build.itemsTab.items[slot.selItemId] or nil
		local shown = true
		if type(slot.shown) == "function" then
			local ok, s = pcall(slot.shown)
			shown = ok and s and true or false
		end
		slots[#slots + 1] = {
			slot = slot.slotName,
			label = opt(slot.label),
			itemId = slot.selItemId or 0,
			itemName = item and item.name or null,
			itemRarity = item and opt(item.rarity) or null,
			nodeId = opt(slot.nodeId),
			weaponSet = opt(slot.weaponSet),
			shown = shown,
			inactive = slot.inactive == true,
		}
	end
	return {
		slots = slots,
		activeItemSet = build.itemsTab.activeItemSetId,
		useSecondWeaponSet = build.itemsTab.activeItemSet.useSecondWeaponSet == true,
	}
end

M.get_items = function()
	ensureBuild()
	local items = array({})
	for _, id in ipairs(build.itemsTab.itemOrderList) do
		local item = build.itemsTab.items[id]
		if item then
			local s = itemSummary(item)
			local ok, slot = pcall(item.GetPrimarySlot, item)
			s.primarySlot = ok and opt(slot) or null
			-- Returns the slot control object; only its name is serialisable.
			local ok2, equipped = pcall(build.itemsTab.GetEquippedSlotForItem, build.itemsTab, item)
			s.equippedSlot = (ok2 and type(equipped) == "table" and opt(equipped.slotName)) or null
			items[#items + 1] = s
		end
	end
	return { items = items }
end

M.parse_item = function(p)
	if not p or type(p.text) ~= "string" then error("params.text is required", 0) end
	local item = new("Item", p.text)
	if not item.base then
		return { ok = false, error = "unrecognised item text" }
	end
	local out = itemSummary(item)
	out.ok = true
	return out
end

M.equip_item_raw = function(p)
	ensureBuild()
	if not p or type(p.text) ~= "string" then error("params.text (raw item text) is required", 0) end
	local item = new("Item", p.text)
	if not item.base then error("could not parse item text (unrecognised base type or format)", 0) end
	build.itemsTab:AddItem(item, true)
	local slotName = p.slot
	if not slotName then
		for _, slot in ipairs(build.itemsTab.orderedSlots) do
			if not slot.inactive and build.itemsTab:IsItemValidForSlot(item, slot.slotName) then
				slotName = slot.slotName
				break
			end
		end
	end
	if not slotName or not build.itemsTab.slots[slotName] then
		error("no compatible slot found for this item; pass params.slot", 0)
	end
	build.itemsTab.slots[slotName]:SetSelItemId(item.id)
	build.itemsTab:AddUndoState()
	refresh()
	return { ok = true, itemId = item.id, slot = slotName, itemName = item.name }
end

M.equip_item = function(p)
	ensureBuild()
	local slot = build.itemsTab.slots[p and p.slot or ""]
	if not slot then error("unknown slot", 0) end
	local id = tonumber(p.itemId) or 0
	if id ~= 0 and not build.itemsTab.items[id] then error("unknown item id", 0) end
	slot:SetSelItemId(id)
	build.itemsTab:AddUndoState()
	refresh()
	return M.list_slots()
end

M.unequip_item = function(p)
	return M.equip_item({ slot = p and p.slot, itemId = 0 })
end

M.delete_item = function(p)
	ensureBuild()
	local item = build.itemsTab.items[tonumber(p and p.itemId) or -1]
	if not item then error("unknown item id", 0) end
	build.itemsTab:DeleteItem(item)
	build.itemsTab:AddUndoState()
	refresh()
	return M.get_items()
end

M.list_item_sets = function()
	ensureBuild()
	local sets = array({})
	for _, id in ipairs(build.itemsTab.itemSetOrderList) do
		local set = build.itemsTab.itemSets[id]
		sets[#sets + 1] = { id = id, title = set.title or "Default", active = (id == build.itemsTab.activeItemSetId) }
	end
	return { itemSets = sets, activeItemSet = build.itemsTab.activeItemSetId }
end

M.select_item_set = function(p)
	ensureBuild()
	local id = tonumber(p and p.id)
	if not id or not build.itemsTab.itemSets[id] then error("unknown item set id", 0) end
	build.itemsTab:SetActiveItemSet(id)
	refresh()
	return M.list_item_sets()
end

M.create_item_set = function(p)
	ensureBuild()
	local set = build.itemsTab:NewItemSet(nil, (p and p.title) or "New Set")
	build.itemsTab:SetActiveItemSet(set.id)
	refresh()
	return M.list_item_sets()
end

M.copy_item_set = function(p)
	ensureBuild()
	local src = tonumber(p and p.id) or build.itemsTab.activeItemSetId
	if not build.itemsTab.itemSets[src] then error("unknown item set id", 0) end
	local set = build.itemsTab:CopyItemSet(src, p and p.title)
	build.itemsTab:SetActiveItemSet(set.id)
	refresh()
	return M.list_item_sets()
end

M.rename_item_set = function(p)
	ensureBuild()
	local id = tonumber(p and p.id)
	if not id or not build.itemsTab.itemSets[id] then error("unknown item set id", 0) end
	if not p.title then error("params.title is required", 0) end
	build.itemsTab:RenameItemSet(id, p.title)
	return M.list_item_sets()
end

M.delete_item_set = function(p)
	ensureBuild()
	local id = tonumber(p and p.id)
	if not id or not build.itemsTab.itemSets[id] then error("unknown item set id", 0) end
	if #build.itemsTab.itemSetOrderList <= 1 then error("cannot delete the only item set", 0) end
	local orderIndex
	for i, sid in ipairs(build.itemsTab.itemSetOrderList) do
		if sid == id then orderIndex = i break end
	end
	build.itemsTab:DeleteItemSet(id, orderIndex)
	build.itemsTab:SetActiveItemSet(build.itemsTab.activeItemSetId)
	refresh()
	return M.list_item_sets()
end

-- ---------------------------------------------------------------------------
-- Skills
-- ---------------------------------------------------------------------------

local function requireGroup(index)
	local group = build.skillsTab.socketGroupList[tonumber(index) or -1]
	if not group then error("unknown socket group index " .. tostring(index), 0) end
	return group
end

-- One entry per skill the group grants, with the extra selectors PoB shows on
-- the build screen for the chosen skill (RefreshSkillSelectControls).
local function groupSkills(group)
	local skills = array({})
	for i, activeSkill in ipairs(group.displaySkillList or {}) do
		local ae = activeSkill.activeEffect
		local ge = ae and ae.grantedEffect
		local entry = { index = i }
		local ok, nm = pcall(build.calcsTab.calcs.getActiveSkillDisplayName, activeSkill)
		entry.name = (ok and nm) or (ge and ge.name) or "?"
		if i == (group.mainActiveSkill or 1) and ge and ae.srcInstance then
			local src = ae.srcInstance
			if ge.parts and #ge.parts > 1 then
				local parts = array({})
				for pi, part in ipairs(ge.parts) do
					parts[pi] = { name = tostring(part.name), stages = part.stages and true or false }
				end
				entry.parts = parts
				entry.part = src.skillPart or 1
			end
			if ge.statSets and #ge.statSets > 1 then
				local sets = array({})
				for _, s in ipairs(ge.statSets) do sets[#sets + 1] = tostring(s.label) end
				entry.statSets = sets
				entry.statSet = src.statSet and src.statSet[ge.id] or 1
			end
			local flags = ae.statSet and ae.statSet.skillFlags or {}
			local partStages = ge.parts and #ge.parts > 1 and ge.parts[src.skillPart or 1] and ge.parts[src.skillPart or 1].stages
			if flags.multiStage or partStages then
				entry.hasStages = true
				entry.stageCount = src.skillStageCount or (activeSkill.skillData and activeSkill.skillData.stagesMin) or 1
			end
			if flags.mine then
				entry.hasMines = true
				entry.mineCount = opt(src.skillMineCount)
			end
			local minionList = activeSkill.minionList or ge.minionList
			if not flags.disable and minionList and minionList[1] then
				local minions = array({})
				for _, mid in ipairs(minionList) do
					local m = data.minions[mid]
					if m then minions[#minions + 1] = { id = mid, name = m.name } end
				end
				if #minions > 0 then
					entry.minions = minions
					entry.minion = opt(src.skillMinion)
				end
			end
			if activeSkill.minion and activeSkill.minion.activeSkillList and activeSkill.minion.activeSkillList[1] then
				local ms = array({})
				for _, msk in ipairs(activeSkill.minion.activeSkillList) do
					ms[#ms + 1] = msk.activeEffect.grantedEffect.name
				end
				entry.minionSkills = ms
				entry.minionSkill = src.skillMinionSkill or 1
			end
		end
		skills[#skills + 1] = entry
	end
	return skills
end

M.get_skills = function()
	ensureBuild()
	local groups = array({})
	for i, group in ipairs(build.skillsTab.socketGroupList) do
		local gems = array({})
		for gi, gem in ipairs(group.gemList) do
			local gd = gem.gemData
			gems[#gems + 1] = {
				index = gi,
				nameSpec = opt(gem.nameSpec),
				name = gd and gd.name or opt(gem.nameSpec),
				gemId = opt(gem.gemId),
				skillId = opt(gem.skillId),
				level = opt(gem.level),
				maxLevel = gd and gd.naturalMaxLevel or 20,
				quality = opt(gem.quality),
				enabled = gem.enabled ~= false,
				support = (gd and gd.grantedEffect and gd.grantedEffect.support) and true or false,
				color = opt(gem.color),
				count = opt(gem.count),
				errMsg = opt(gem.errMsg),
			}
		end
		groups[#groups + 1] = {
			index = i,
			label = opt(group.label),
			displayLabel = opt(group.displayLabel),
			enabled = group.enabled ~= false,
			includeInFullDPS = group.includeInFullDPS == true,
			slot = opt(group.slot),
			source = opt(group.source),
			mainActiveSkill = opt(group.mainActiveSkill),
			gems = gems,
			skills = groupSkills(group),
			isMainSkill = (build.mainSocketGroup == i),
		}
	end
	local sets = array({})
	for _, id in ipairs(build.skillsTab.skillSetOrderList) do
		local set = build.skillsTab.skillSets[id]
		if set then
			sets[#sets + 1] = { id = id, title = set.title or "Default", active = (id == build.skillsTab.activeSkillSetId) }
		end
	end
	return {
		socketGroups = groups,
		mainSocketGroup = opt(build.mainSocketGroup),
		skillSets = sets,
		activeSkillSet = opt(build.skillsTab.activeSkillSetId),
	}
end

-- Selectors for the chosen skill of a group (part, stat set, stages, minion…).
M.set_main_skill_options = function(p)
	ensureBuild()
	local group = requireGroup(p and p.groupIndex)
	if p.mainActiveSkill ~= nil then group.mainActiveSkill = tonumber(p.mainActiveSkill) end
	local activeSkill = group.displaySkillList and group.displaySkillList[group.mainActiveSkill or 1]
	local ae = activeSkill and activeSkill.activeEffect
	local src = ae and ae.srcInstance
	if src then
		if p.part ~= nil then src.skillPart = tonumber(p.part) end
		if p.statSet ~= nil and ae.grantedEffect then
			src.statSet = src.statSet or {}
			src.statSet[ae.grantedEffect.id] = tonumber(p.statSet)
		end
		if p.stageCount ~= nil then src.skillStageCount = tonumber(p.stageCount) end
		if p.mineCount ~= nil then src.skillMineCount = tonumber(p.mineCount) end
		if p.minionId ~= nil then
			src.skillMinion = p.minionId
			src.skillMinionCalcs = p.minionId
		end
		if p.minionSkill ~= nil then src.skillMinionSkill = tonumber(p.minionSkill) end
	end
	build.modFlag = true
	refresh()
	return M.get_skills()
end

M.move_socket_group = function(p)
	ensureBuild()
	local list = build.skillsTab.socketGroupList
	local from = tonumber(p and p.from)
	local to = tonumber(p and p.to)
	if not from or not to or not list[from] or to < 1 or to > #list then error("bad from/to", 0) end
	local group = table.remove(list, from)
	table.insert(list, to, group)
	local m = build.mainSocketGroup or 1
	if m == from then
		build.mainSocketGroup = to
	elseif from < m and to >= m then
		build.mainSocketGroup = m - 1
	elseif from > m and to <= m then
		build.mainSocketGroup = m + 1
	end
	build.skillsTab:AddUndoState()
	refresh()
	return M.get_skills()
end

M.move_gem = function(p)
	ensureBuild()
	local group = requireGroup(p and p.groupIndex)
	local from = tonumber(p and p.from)
	local to = tonumber(p and p.to)
	if not from or not to or not group.gemList[from] or to < 1 or to > #group.gemList then error("bad from/to", 0) end
	local gem = table.remove(group.gemList, from)
	table.insert(group.gemList, to, gem)
	build.skillsTab:ProcessSocketGroup(group)
	build.skillsTab:AddUndoState()
	refresh()
	return M.get_skills()
end

-- Support/global-effect gems scored by their DPS impact on a group, exactly as
-- GemSelectControl does it: a hypothetical gem instance is appended to the
-- group, the misc calculator runs, and the instance is removed again. Cached
-- per (revision, group, field): ~2s cold for a full support list, then free.
local gemDpsCache

-- Gems worth scoring for a group: supports valid for one of its active
-- skills, plus actives with a global effect.
local function gemDpsCandidates(group)
	local displaySkills = group.displaySkillList or {}
	local ids = {}
	for gemId, gemData in pairs(data.gems) do
		local ge = gemData.grantedEffect
		if ge and not ge.hidden then
			local score = false
			if ge.support then
				for _, activeSkill in ipairs(displaySkills) do
					local ok, s = pcall(calcLib.canGrantedEffectSupportActiveSkill, ge, activeSkill)
					if ok and s then score = true break end
				end
			elseif ge.hasGlobalEffect then
				score = true
			end
			if score then ids[#ids + 1] = gemId end
		end
	end
	table.sort(ids)
	return ids
end

-- Score gems for a group the way GemSelectControl does: a hypothetical gem
-- instance is appended, the misc calculator runs, the instance is removed.
local function scoreGems(group, gemIds, dpsField)
	local useFullDPS = dpsField == "FullDPS"
	local fastCalcOptions = { nodeAlloc = true, requirementsItems = true, requirementsGems = true, skipEHP = dpsField ~= "TotalEHP", fullDPSOnly = useFullDPS }
	local calcFunc, calcBase = build.calcsTab:GetMiscCalculator(build)
	local function fieldOf(output)
		return (useFullDPS and output[dpsField] ~= nil and output[dpsField])
			or (output.Minion and output.Minion.CombinedDPS)
			or (output[dpsField] ~= nil and output[dpsField])
			or 0
	end
	local dps = {}
	local gemList = group.gemList
	local slotIndex = #gemList + 1
	for _, gemId in ipairs(gemIds) do
		local gemData = data.gems[gemId]
		if gemData then
			gemList[slotIndex] = {
				level = 1,
				quality = build.skillsTab.defaultGemQuality or 0,
				count = 1,
				enabled = true,
				enableGlobal1 = true,
				enableGlobal2 = true,
				gemId = gemData.id,
				nameSpec = gemData.name,
				skillId = gemData.grantedEffectId,
			}
			gemList[slotIndex].level = build.skillsTab:ProcessGemLevel(gemData)
			gemList[slotIndex].gemData = gemData
			local ok, output = pcall(calcFunc, nil, useFullDPS, fastCalcOptions)
			gemList[slotIndex] = nil
			if ok and output then
				dps[gemId] = fieldOf(output)
			end
		end
	end
	return dps, fieldOf(calcBase)
end

local function gemDpsKey(groupIndex, dpsField)
	return string.format("%d:%d:%s", build.outputRevision, groupIndex, dpsField)
end

-- Cached per (revision, group, field): ~0.7s cold single-threaded, free
-- afterwards; the pool path (gem_dps_candidates / score_gems /
-- gem_dps_apply) fills the same cache from worker engines.
local function gemDpsFor(group, groupIndex)
	local dpsField = build.skillsTab.sortGemsByDPSField or "FullDPS"
	local key = gemDpsKey(groupIndex, dpsField)
	if gemDpsCache and gemDpsCache.key == key then
		return gemDpsCache
	end
	local dps, base = scoreGems(group, gemDpsCandidates(group), dpsField)
	gemDpsCache = { key = key, base = base, dps = dps }
	return gemDpsCache
end

M.gem_dps_candidates = function(p)
	ensureBuild()
	local groupIndex = tonumber(p and p.groupIndex)
	local group = groupIndex and build.skillsTab.socketGroupList[groupIndex]
	if not group then error("unknown socket group", 0) end
	local dpsField = build.skillsTab.sortGemsByDPSField or "FullDPS"
	local key = gemDpsKey(groupIndex, dpsField)
	if gemDpsCache and gemDpsCache.key == key then
		return { cached = true, key = key, gemIds = array({}), dpsField = dpsField }
	end
	return { cached = false, key = key, gemIds = strArray(gemDpsCandidates(group)), dpsField = dpsField }
end

-- Worker side.
M.score_gems = function(p)
	ensureBuild()
	local groupIndex = tonumber(p and p.groupIndex)
	local group = groupIndex and build.skillsTab.socketGroupList[groupIndex]
	if not group then error("unknown socket group", 0) end
	local dps, base = scoreGems(group, p.gemIds or {}, p.dpsField or "FullDPS")
	return { dps = dps, base = base }
end

M.gem_dps_apply = function(p)
	ensureBuild()
	if not p or not p.key then error("params.key is required", 0) end
	local dps = {}
	for gemId, v in pairs(p.dps or {}) do
		if type(v) == "number" then dps[gemId] = v end
	end
	gemDpsCache = { key = p.key, base = num(p.base) or 0, dps = dps }
	return { ok = true, count = (function() local n = 0 for _ in pairs(dps) do n = n + 1 end return n end)() }
end

-- Gem picker: name/tag search plus per-group support validity, PoB's colours,
-- optional DPS-impact scoring and ordering.
M.gem_search = function(p)
	ensureBuild()
	p = p or {}
	local limit = tonumber(p.limit) or 100
	local q = (p.query or ""):lower()
	local groupIndex = tonumber(p.groupIndex)
	local group = groupIndex and build.skillsTab.socketGroupList[groupIndex]
	local activeSkill = group and group.displaySkillList and group.displaySkillList[group.mainActiveSkill or 1]
	local gemColor = { [1] = colorCodes.STRENGTH, [2] = colorCodes.DEXTERITY, [3] = colorCodes.INTELLIGENCE }
	local dpsCache = (p.sortByDps and group) and gemDpsFor(group, groupIndex) or nil
	local out = array({})
	local total = 0
	for gemId, gemData in pairs(data.gems) do
		local ge = gemData.grantedEffect
		if ge and not ge.hidden then
			local match = q == ""
				or gemData.name:lower():find(q, 1, true) ~= nil
				or (gemData.tagString or ""):lower():find(q, 1, true) ~= nil
			local support = ge.support == true
			if match and (p.onlySupports == nil or support == p.onlySupports) then
				total = total + 1
				local valid = true
				if support and activeSkill then
					local ok, s = pcall(calcLib.canGrantedEffectSupportActiveSkill, ge, activeSkill)
					valid = (ok and s) and true or false
				end
				local row = {
					gemId = gemId,
					name = gemData.name or gemId,
					support = support,
					valid = valid,
					color = gemColor[ge.color] or "^7",
					tags = opt(gemData.tagString),
					family = opt(gemData.gemFamily),
					gemType = opt(gemData.gemType),
					maxLevel = gemData.naturalMaxLevel or 20,
					tier = opt(gemData.Tier),
					legacy = ge.legacy and true or false,
				}
				if dpsCache and dpsCache.dps[gemId] then
					row.dps = dpsCache.dps[gemId]
					row.dpsDiff = dpsCache.dps[gemId] - dpsCache.base
				end
				out[#out + 1] = row
			end
		end
	end
	table.sort(out, function(a, b)
		if a.valid ~= b.valid then return a.valid end
		if dpsCache then
			local da, db = a.dpsDiff, b.dpsDiff
			if (da ~= nil) ~= (db ~= nil) then return da ~= nil end
			if da and db and da ~= db then return da > db end
		end
		if a.support ~= b.support then return b.support end
		return a.name < b.name
	end)
	while #out > limit do table.remove(out) end
	return { gems = out, total = total, truncated = (total > #out), baseDps = dpsCache and dpsCache.base or null }
end

-- Per-build gem defaults; SkillsTab persists them in the build file.
M.get_skills_options = function()
	ensureBuild()
	return {
		defaultGemLevel = build.skillsTab.defaultGemLevel or "normalMaximum",
		defaultGemQuality = build.skillsTab.defaultGemQuality or 0,
		sortGemsByDPSField = build.skillsTab.sortGemsByDPSField or "FullDPS",
	}
end

M.set_skills_options = function(p)
	ensureBuild()
	p = p or {}
	if p.defaultGemLevel ~= nil then
		build.skillsTab.defaultGemLevel = p.defaultGemLevel
		pcall(function() build.skillsTab.controls.defaultLevel:SelByValue(p.defaultGemLevel, "gemLevel") end)
	end
	if p.defaultGemQuality ~= nil then
		build.skillsTab.defaultGemQuality = math.max(math.min(tonumber(p.defaultGemQuality) or 0, 23), 0)
		pcall(function() build.skillsTab.controls.defaultQuality:SetText(tostring(build.skillsTab.defaultGemQuality)) end)
	end
	if p.sortGemsByDPSField ~= nil then build.skillsTab.sortGemsByDPSField = p.sortGemsByDPSField end
	build.modFlag = true
	return M.get_skills_options()
end

M.copy_socket_group = function(p)
	ensureBuild()
	local group = requireGroup(p and p.index)
	build.skillsTab:CopySocketGroup(group)
	local text = __clipboard
	__clipboard = nil
	return { text = text or "" }
end

M.paste_socket_group = function(p)
	ensureBuild()
	if not p or type(p.text) ~= "string" or p.text == "" then error("params.text is required", 0) end
	local before = #build.skillsTab.socketGroupList
	build.skillsTab:PasteSocketGroup(p.text)
	if #build.skillsTab.socketGroupList == before then
		error("no valid socket group found in the pasted text", 0)
	end
	refresh()
	return M.get_skills()
end

local gemTooltipModule

-- PoB's own gem tooltip (GemTooltip.lua), returned as sized, colour-coded lines.
M.gem_tooltip = function(p)
	ensureBuild()
	local group = requireGroup(p and p.groupIndex)
	local gem = group.gemList[tonumber(p and p.gemIndex) or -1]
	if not gem then error("unknown gem index", 0) end
	if not gem.gemData then error("gem is not resolved to any gem data", 0) end
	gemTooltipModule = gemTooltipModule or LoadModule("Classes/GemTooltip")
	local tt = new("Tooltip"):Tooltip()
	gemTooltipModule.AddGemTooltip(tt, build, gem)
	local lines = array({})
	for _, l in ipairs(tt.lines) do
		lines[#lines + 1] = {
			size = l.size or 14,
			text = l.text or "",
			center = l.center == true,
			sep = (l.separatorImage ~= nil or l.text == nil) and true or false,
		}
	end
	return { lines = lines }
end

M.select_skill_set = function(p)
	ensureBuild()
	local id = tonumber(p and p.id)
	if not id or not build.skillsTab.skillSets[id] then error("unknown skill set id " .. tostring(p and p.id), 0) end
	build.skillsTab:SetActiveSkillSet(id)
	refresh()
	return M.get_skills()
end

M.create_skill_set = function(p)
	ensureBuild()
	local set = build.skillsTab:NewSkillSet(nil, (p and p.title) or "New Set")
	build.skillsTab:SetActiveSkillSet(set.id)
	refresh()
	return M.get_skills()
end

M.copy_skill_set = function(p)
	ensureBuild()
	local src = tonumber(p and p.id) or build.skillsTab.activeSkillSetId
	if not build.skillsTab.skillSets[src] then error("unknown skill set id", 0) end
	local set = build.skillsTab:CopySkillSet(src, p and p.title)
	build.skillsTab:SetActiveSkillSet(set.id)
	refresh()
	return M.get_skills()
end

M.rename_skill_set = function(p)
	ensureBuild()
	local id = tonumber(p and p.id)
	if not id or not build.skillsTab.skillSets[id] then error("unknown skill set id", 0) end
	if not p.title then error("params.title is required", 0) end
	build.skillsTab:RenameSkillSet(id, p.title)
	return M.get_skills()
end

M.delete_skill_set = function(p)
	ensureBuild()
	local id = tonumber(p and p.id)
	if not id or not build.skillsTab.skillSets[id] then error("unknown skill set id", 0) end
	if #build.skillsTab.skillSetOrderList <= 1 then error("cannot delete the only skill set", 0) end
	local orderIndex
	for i, sid in ipairs(build.skillsTab.skillSetOrderList) do
		if sid == id then orderIndex = i break end
	end
	build.skillsTab:DeleteSkillSet(id, orderIndex)
	if build.skillsTab.activeSkillSetId == id then
		build.skillsTab:SetActiveSkillSet(build.skillsTab.skillSetOrderList[1])
	end
	refresh()
	return M.get_skills()
end

M.add_socket_group = function(p)
	ensureBuild()
	local group = { label = (p and p.label) or "", enabled = true, gemList = {} }
	if p and p.slot then group.slot = p.slot end
	table.insert(build.skillsTab.socketGroupList, group)
	if not build.mainSocketGroup or build.mainSocketGroup == 0 then
		build.mainSocketGroup = #build.skillsTab.socketGroupList
	end
	build.skillsTab:ProcessSocketGroup(group)
	build.skillsTab:AddUndoState()
	refresh()
	return { ok = true, groupIndex = #build.skillsTab.socketGroupList }
end

M.remove_socket_group = function(p)
	ensureBuild()
	local index = tonumber(p and p.index)
	requireGroup(index)
	table.remove(build.skillsTab.socketGroupList, index)
	if build.mainSocketGroup and build.mainSocketGroup > #build.skillsTab.socketGroupList then
		build.mainSocketGroup = math.max(1, #build.skillsTab.socketGroupList)
	end
	build.skillsTab:AddUndoState()
	refresh()
	return M.get_skills()
end

M.set_socket_group = function(p)
	ensureBuild()
	local group = requireGroup(p and p.index)
	if p.enabled ~= nil then group.enabled = p.enabled end
	if p.includeInFullDPS ~= nil then group.includeInFullDPS = p.includeInFullDPS end
	if p.label ~= nil then group.label = p.label end
	if p.slot ~= nil then group.slot = (p.slot ~= "" and p.slot) or nil end
	if p.mainActiveSkill ~= nil then group.mainActiveSkill = tonumber(p.mainActiveSkill) end
	build.skillsTab:ProcessSocketGroup(group)
	build.skillsTab:AddUndoState()
	refresh()
	return M.get_skills()
end

M.set_main_skill = function(p)
	ensureBuild()
	local index = tonumber(p and p.index)
	if not index then error("params.index is required", 0) end
	build.mainSocketGroup = index
	refresh()
	return M.get_skills()
end

M.add_gem = function(p)
	ensureBuild()
	if not p or not p.groupIndex or not (p.gemId or p.skillId or p.nameSpec) then
		error("params.groupIndex and params.gemId (or skillId/nameSpec) are required", 0)
	end
	local group = requireGroup(p.groupIndex)
	local gemData = p.gemId and data.gems[p.gemId]
	local level = tonumber(p.level)
	if not level then
		level = gemData and build.skillsTab:ProcessGemLevel(gemData) or 1
	end
	local gem = {
		nameSpec = p.nameSpec or "",
		gemId = p.gemId,
		skillId = p.skillId,
		level = level,
		quality = tonumber(p.quality) or build.skillsTab.defaultGemQuality or 0,
		enabled = true,
		count = 1,
		enableGlobal1 = true,
		enableGlobal2 = true,
		corrupted = build.skillsTab.defaultCorruptionState or false,
		corruptLevel = build.skillsTab.defaultCorruptionLevel or 0,
	}
	table.insert(group.gemList, gem)
	build.skillsTab:ProcessSocketGroup(group)
	build.skillsTab:AddUndoState()
	refresh()
	return M.get_skills()
end

M.set_gem = function(p)
	ensureBuild()
	if not p or not p.groupIndex or not p.gemIndex then
		error("params.groupIndex and params.gemIndex are required", 0)
	end
	local group = requireGroup(p.groupIndex)
	local gem = group.gemList[tonumber(p.gemIndex)]
	if not gem then error("unknown gem index", 0) end
	if p.level ~= nil then gem.level = tonumber(p.level) end
	if p.quality ~= nil then gem.quality = tonumber(p.quality) end
	if p.enabled ~= nil then gem.enabled = p.enabled end
	if p.count ~= nil then gem.count = tonumber(p.count) end
	if p.gemId ~= nil then gem.gemId = p.gemId; gem.skillId = nil end
	if p.nameSpec ~= nil then gem.nameSpec = p.nameSpec end
	build.skillsTab:ProcessSocketGroup(group)
	build.skillsTab:AddUndoState()
	refresh()
	return M.get_skills()
end

M.remove_gem = function(p)
	ensureBuild()
	local group = requireGroup(p and p.groupIndex)
	if not group.gemList[tonumber(p.gemIndex) or -1] then error("unknown gem index", 0) end
	table.remove(group.gemList, tonumber(p.gemIndex))
	build.skillsTab:ProcessSocketGroup(group)
	build.skillsTab:AddUndoState()
	refresh()
	return M.get_skills()
end

M.list_gems = function(p)
	p = p or {}
	local query = p.query and tostring(p.query):lower() or nil
	local limit = tonumber(p.limit) or 100
	local out = array({})
	local total = 0
	for gemId, gemData in pairs(data.gems) do
		local isSupport = (gemData.grantedEffect and gemData.grantedEffect.support) and true or false
		local include = true
		if p.onlySupports ~= nil then include = (isSupport == p.onlySupports) end
		if include and query and query ~= "" then
			include = (gemData.name and gemData.name:lower():find(query, 1, true)) ~= nil
				or gemId:lower():find(query, 1, true) ~= nil
		end
		if include then
			total = total + 1
			if #out < limit then
				out[#out + 1] = {
					gemId = gemId,
					name = gemData.name or gemId,
					support = isSupport,
					tags = gemData.tagString and opt(gemData.tagString) or null,
					color = opt(gemData.color),
				}
			end
		end
	end
	table.sort(out, function(a, b) return (a.name or "") < (b.name or "") end)
	return { gems = out, total = total, truncated = (total > #out) }
end

M.list_valid_supports = function(p)
	ensureBuild()
	local group = requireGroup(p and p.groupIndex)
	local activeSkill = group.displaySkillList and group.displaySkillList[group.mainActiveSkill or 1]
	local results = array({})
	if not activeSkill then
		return { supports = results }
	end
	for gemId, gemData in pairs(data.gems) do
		if gemData.grantedEffect and gemData.grantedEffect.support then
			local ok, supports = pcall(calcLib.canGrantedEffectSupportActiveSkill, gemData.grantedEffect, activeSkill)
			if ok and supports then
				results[#results + 1] = { gemId = gemId, name = gemData.name or gemId }
			end
		end
	end
	table.sort(results, function(a, b) return a.name < b.name end)
	return { supports = results }
end

-- ---------------------------------------------------------------------------
-- Item database, tooltips, editing, weapon sets
-- ---------------------------------------------------------------------------

-- The unique/rare DBs parse on a coroutine that PoB resumes once per frame;
-- pump frames until they finish (one-time cost on first use).
local function ensureItemDb()
	local guard = 0
	while (main.uniqueDB.loading or main.rareDB.loading) and guard < 2000 do
		frame()
		guard = guard + 1
	end
	if main.uniqueDB.loading or main.rareDB.loading then
		error("item databases are still loading", 0)
	end
end

local function dbFor(name)
	if name == "rare" then return main.rareDB end
	return main.uniqueDB
end

M.item_db_list = function(p)
	ensureBuild()
	p = p or {}
	ensureItemDb()
	local db = dbFor(p.db)
	local q = (p.query or ""):lower()
	local wantType = p.type
	local rows = {}
	local types = {}
	for name, item in pairs(db.list) do
		local itype = item.type or "?"
		types[itype] = (types[itype] or 0) + 1
		local match = (q == "" or name:lower():find(q, 1, true) ~= nil or (item.baseName or ""):lower():find(q, 1, true) ~= nil)
			and (not wantType or itype == wantType)
		if match then
			rows[#rows + 1] = {
				name = name,
				rarity = opt(item.rarity),
				type = itype,
				baseName = opt(item.baseName),
				slot = opt(item:GetPrimarySlot()),
				league = opt(item.league),
				variants = item.variantList and #item.variantList or 0,
				upgrade = item.upgradePaths and true or false,
			}
		end
	end
	table.sort(rows, function(a, b) return a.name < b.name end)
	local total = #rows
	local offset = tonumber(p.offset) or 0
	local limit = tonumber(p.limit) or 100
	local page = array({})
	for i = offset + 1, math.min(offset + limit, total) do
		page[#page + 1] = rows[i]
	end
	local typeList = array({})
	for t, n in pairs(types) do typeList[#typeList + 1] = { type = t, count = n } end
	table.sort(typeList, function(a, b) return a.type < b.type end)
	return { items = page, total = total, offset = offset, types = typeList }
end

local function tooltipLines(tt)
	local lines = array({})
	for _, l in ipairs(tt.lines) do
		lines[#lines + 1] = {
			size = l.size or 14,
			text = l.text or "",
			center = l.center == true,
			sep = (l.separatorImage ~= nil or l.text == nil) and true or false,
		}
	end
	return lines
end

local function resolveItem(p)
	if p.itemId then
		local item = build.itemsTab.items[tonumber(p.itemId)]
		if not item then error("unknown item id " .. tostring(p.itemId), 0) end
		return item, false
	end
	if p.db and p.name then
		ensureItemDb()
		local item = dbFor(p.db).list[p.name]
		if not item then error("unknown database item " .. tostring(p.name), 0) end
		return item, true
	end
	if p.raw then
		local item = new("Item"):Item(p.raw)
		if not item.base then error("unrecognised item text", 0) end
		return item, true
	end
	error("params.itemId, params.db+name or params.raw is required", 0)
end

-- PoB's full item tooltip, including the "Equipping this item in X will give
-- you" comparison sections when a slot is given (or the item's primary slot).
M.item_tooltip = function(p)
	ensureBuild()
	p = p or {}
	local item, dbMode = resolveItem(p)
	local slot
	if p.slotName ~= false then
		local slotName = p.slotName or item:GetPrimarySlot()
		slot = slotName and build.itemsTab.slots[slotName] or nil
	end
	local tt = new("Tooltip"):Tooltip()
	build.itemsTab:AddItemTooltip(tt, item, slot, dbMode and p.itemId == nil)
	return { lines = tooltipLines(tt), rarity = opt(item.rarity) }
end

M.item_db_equip = function(p)
	ensureBuild()
	if not p or not p.name then error("params.db and params.name are required", 0) end
	ensureItemDb()
	local dbItem = dbFor(p.db).list[p.name]
	if not dbItem then error("unknown database item " .. tostring(p.name), 0) end
	return M.equip_item_raw({ text = dbItem:BuildRaw(), slot = p.slotName })
end

-- Canonical raw text for the edit dialog.
M.item_raw = function(p)
	ensureBuild()
	local item = build.itemsTab.items[tonumber(p and p.itemId) or -1]
	if not item then error("unknown item id", 0) end
	return { raw = item:BuildRaw() }
end

-- Create a new item from raw text, or replace an existing one (same id keeps
-- every slot assignment pointing at the edited item).
M.item_edit = function(p)
	ensureBuild()
	if not p or type(p.text) ~= "string" or p.text == "" then error("params.text is required", 0) end
	local item = new("Item"):Item(p.text)
	if not item.base then error("unrecognised item text (check the base type line)", 0) end
	if p.itemId then
		if not build.itemsTab.items[tonumber(p.itemId)] then error("unknown item id", 0) end
		item.id = tonumber(p.itemId)
	end
	build.itemsTab:AddItem(item, true)
	build.itemsTab:PopulateSlots()
	build.itemsTab:AddUndoState()
	refresh()
	return { ok = true, itemId = item.id, name = item.name }
end

local function requireItem(p)
	local item = build.itemsTab.items[tonumber(p and p.itemId) or -1]
	if not item then error("unknown item id " .. tostring(p and p.itemId), 0) end
	return item
end

local function commitItemEdit(item)
	item:BuildAndParseRaw()
	build.itemsTab:PopulateSlots()
	build.itemsTab:AddUndoState()
	refresh()
end

-- ---------------------------------------------------------------------------
-- Crafting: bases, affixes, runes (ItemsTab:CraftItem / UpdateAffixControl)
-- ---------------------------------------------------------------------------

M.craft_bases = function()
	local types = strArray(data.itemBaseTypeList)
	local bases = {}
	for _, t in ipairs(data.itemBaseTypeList) do
		local list = array({})
		for _, e in ipairs(data.itemBaseLists[t] or {}) do
			list[#list + 1] = {
				name = e.name,
				label = opt(e.label),
				subType = e.base and opt(e.base.subType) or null,
			}
		end
		bases[t] = list
	end
	return { types = types, bases = bases }
end

-- Same construction as CraftItem's makeItem.
M.craft_item = function(p)
	ensureBuild()
	if not p or not p.type or not p.baseName then error("params.type and params.baseName are required", 0) end
	local entry
	for _, e in ipairs(data.itemBaseLists[p.type] or {}) do
		if e.name == p.baseName then entry = e break end
	end
	if not entry then error("unknown base " .. tostring(p.baseName) .. " in type " .. tostring(p.type), 0) end
	local base = entry
	local rarity = p.rarity or "RARE"
	local item = new("Item"):Item()
	item.name = base.name
	item.base = base.base
	item.baseName = base.name
	item.charmLimit = base.charmLimit
	item.spiritValue = base.spiritValue
	item.buffModLines = {}
	item.enchantModLines = {}
	item.runeModLines = {}
	item.classRequirementModLines = {}
	item.implicitModLines = {}
	item.explicitModLines = {}
	item.sockets = {}
	item.runes = {}
	item.quality = base.base.quality and 0 or nil
	if base.base.socketLimit and (base.base.weapon or base.base.armour or base.base.tags.wand or base.base.tags.staff or base.base.tags.sceptre) then
		for _ = 1, base.base.socketLimit do
			table.insert(item.sockets, { group = 0 })
		end
		item.itemSocketCount = #item.sockets
	end
	if (base.base.flask or (base.base.type == "Jewel" and base.base.subType == "Charm") or base.base.type == "Charm") and rarity == "RARE" then
		rarity = "MAGIC"
	end
	if base.base.type == "Transcendent Limb" then
		rarity = "NORMAL"
	end
	if rarity == "MAGIC" or rarity == "RARE" then
		item.crafted = true
	end
	item.rarity = rarity
	if rarity == "RARE" or rarity == "UNIQUE" then
		item.title = (p.title and p.title:match("%S")) and p.title or "New Item"
	end
	if base.base.implicit then
		local implicitIndex = 1
		for line in base.base.implicit:gmatch("[^\n]+") do
			local modList, extra = modLib.parseMod(line)
			table.insert(item.implicitModLines, { line = line, extra = extra, modList = modList or {}, modTags = base.base.implicitModTypes and base.base.implicitModTypes[implicitIndex] or {} })
			implicitIndex = implicitIndex + 1
		end
	end
	if base.base.variantList then
		item.variantList = copyTable(base.base.variantList, true)
		item.variant = 1
		item.baseLines = {}
	end
	if base.base.type == "Jewel" and base.base.subType == "Radius" then
		item.jewelRadiusLabel = "Small"
	end
	item:NormaliseQuality()
	item:BuildAndParseRaw()
	build.itemsTab:AddItem(item, true)
	if p.equip then
		for _, slot in ipairs(build.itemsTab.orderedSlots) do
			if not slot.inactive and build.itemsTab:IsItemValidForSlot(item, slot.slotName) then
				slot:SetSelItemId(item.id)
				break
			end
		end
	end
	build.itemsTab:PopulateSlots()
	build.itemsTab:AddUndoState()
	refresh()
	return { ok = true, itemId = item.id, name = item.name, crafted = item.crafted == true }
end

local function affixSlotOptions(item, affixType, tableName, outputIndex)
	local extraTags, excludeGroups = {}, {}
	for _, tbl in ipairs({ "prefixes", "suffixes" }) do
		for index = 1, (item[tbl].limit or (item.affixLimit / 2)) do
			if index ~= outputIndex or tbl ~= tableName then
				local mod = item.affixes[item[tbl][index] and item[tbl][index].modId]
				if mod then
					if mod.group then excludeGroups[mod.group] = true end
					for _, tag in ipairs(mod.tags or {}) do extraTags[tag] = true end
				end
			end
		end
	end
	local affixList = {}
	for modId, mod in pairs(item.affixes) do
		if mod.type == affixType and not excludeGroups[mod.group] and item:GetModSpawnWeight(mod, extraTags) > 0 then
			affixList[#affixList + 1] = modId
		end
	end
	table.sort(affixList, function(a, b)
		local modA = item.affixes[a]
		local modB = item.affixes[b]
		for i = 1, math.max(#modA, #modB) do
			if not modA[i] then
				return true
			elseif not modB[i] then
				return false
			elseif modA.statOrder[i] ~= modB.statOrder[i] then
				return modA.statOrder[i] < modB.statOrder[i]
			end
		end
		return modA.level > modB.level
	end)
	local opts = array({})
	for _, modId in ipairs(affixList) do
		local mod = item.affixes[modId]
		local modString = table.concat(mod, "/")
		opts[#opts + 1] = {
			modId = modId,
			affix = opt(mod.affix),
			label = modString,
			level = opt(mod.level),
			haveRange = modString:match("%(%-?[%d%.]+%-%-?[%d%.]+%)") and true or false,
		}
	end
	return opts
end

M.item_affixes = function(p)
	ensureBuild()
	local item = requireItem(p)
	if not item.crafted or not item.affixes then
		return { crafted = false, prefixes = array({}), suffixes = array({}) }
	end
	local function slots(tableName, affixType)
		local limit = item[tableName].limit or (item.affixLimit / 2)
		local out = array({})
		for i = 1, limit do
			local cur = item[tableName][i] or { modId = "None" }
			local curMod = item.affixes[cur.modId]
			out[#out + 1] = {
				index = i,
				modId = cur.modId,
				range = cur.range or (main.defaultItemAffixQuality or 0.5),
				label = curMod and table.concat(curMod, "/") or null,
				affix = curMod and opt(curMod.affix) or null,
				options = affixSlotOptions(item, affixType, tableName, i),
			}
		end
		return out
	end
	return {
		crafted = true,
		affixLimit = item.affixLimit,
		prefixes = slots("prefixes", "Prefix"),
		suffixes = slots("suffixes", "Suffix"),
	}
end

M.set_item_affix = function(p)
	ensureBuild()
	local item = requireItem(p)
	if not item.crafted or not item.affixes then error("only crafted magic/rare items expose affixes", 0) end
	local tableName = p.table == "suffixes" and "suffixes" or "prefixes"
	local index = tonumber(p.index) or 1
	local limit = item[tableName].limit or (item.affixLimit / 2)
	if index < 1 or index > limit then error("affix index out of range", 0) end
	item[tableName][index] = {
		modId = p.modId or "None",
		range = tonumber(p.range) or (main.defaultItemAffixQuality or 0.5),
	}
	item:Craft()
	commitItemEdit(item)
	return M.item_affixes({ itemId = p.itemId })
end

M.item_runes = function(p)
	ensureBuild()
	local item = requireItem(p)
	local sockets = item.itemSocketCount or 0
	local runes = array({})
	for i = 1, sockets do
		runes[i] = item.runes and item.runes[i] or "None"
	end
	local options = array({})
	if sockets > 0 then
		for _, r in ipairs(build.itemsTab:GetValidRunesForItem(item)) do
			options[#options + 1] = {
				name = r.name,
				label = opt(r.label),
				lines = strArray(r.lines),
				req = opt(r.req),
				type = opt(r.type),
				limit = opt(r.limit),
			}
		end
	end
	return { socketCount = sockets, runes = runes, options = options }
end

M.set_item_rune = function(p)
	ensureBuild()
	local item = requireItem(p)
	local index = tonumber(p and p.index)
	if not index or index < 1 or index > (item.itemSocketCount or 0) then error("rune index out of range", 0) end
	item.runes[index] = p.name or "None"
	item:UpdateRunes()
	commitItemEdit(item)
	return M.item_runes({ itemId = p.itemId })
end

-- Catalysts (rings/amulets): same list and defaults as ItemsTab's dropdown.
local catalystNames = {
	"Flesh (Life)", "Neural (Mana)", "Carapace (Defense)", "Uul-Netol's (Physical)",
	"Xoph's (Fire)", "Tul's (Cold)", "Esh's (Lightning)", "Chayula's (Chaos)",
	"Reaver (Attack)", "Sibilant (Caster)", "Skittering (Speed)", "Adaptive (Attribute)",
	"Necrotic (Minion)",
}

M.set_item_props = function(p)
	ensureBuild()
	local item = requireItem(p)
	if p.quality ~= nil and item.base and item.base.quality then
		item.quality = math.max(0, math.min(tonumber(p.quality) or 0, 50))
	end
	if p.itemLevel ~= nil then
		item.itemLevel = math.max(1, math.min(tonumber(p.itemLevel) or 1, 100))
	end
	if p.corrupted ~= nil then
		item.corrupted = p.corrupted == true
	end
	if p.catalyst ~= nil then
		item.catalyst = math.max(0, math.min(tonumber(p.catalyst) or 0, #catalystNames))
		if item.catalyst > 0 and not item.catalystQuality then
			item.catalystQuality = item.name:match("Breach Ring") and 50 or 20
		end
	end
	if p.catalystQuality ~= nil then
		item.catalystQuality = math.max(0, math.min(tonumber(p.catalystQuality) or 0, 100))
	end
	commitItemEdit(item)
	return { ok = true }
end

M.catalyst_info = function(p)
	ensureBuild()
	local item = requireItem(p)
	local usable = (item.crafted or item.hasModTags) and item.base and (item.base.type == "Amulet" or item.base.type == "Ring")
	return {
		usable = usable and true or false,
		names = strArray(catalystNames),
		catalyst = item.catalyst or 0,
		quality = item.catalystQuality or 0,
	}
end

-- ---------------------------------------------------------------------------
-- Anoints: Distilled Emotion recipes allocating a notable (enchant line
-- "Allocates <name>"), mirroring ItemsTab:AnointDisplayItem/anointItem.
-- ---------------------------------------------------------------------------

M.item_anoints = function(p)
	ensureBuild()
	local item = requireItem(p)
	local anointable = item.canBeAnointed or (item.base and item.base.type == "Amulet")
	local current = strArray(build.itemsTab:getAnoint(item) or {})
	local nodes = array({})
	if anointable and p and p.withNodes then
		for _, node in pairs(build.spec.tree.nodes) do
			if node.recipe and #node.recipe >= 1 then
				nodes[#nodes + 1] = {
					id = node.id,
					name = node.dn or "?",
					stats = strArray(node.sd or {}),
					recipe = strArray(node.recipe),
					allocated = build.spec.allocNodes[node.id] ~= nil,
				}
			end
		end
		table.sort(nodes, function(a, b) return a.name < b.name end)
	end
	local slots = 1
	if item.canHaveTwoEnchants and #item.enchantModLines > 0 then slots = 2 end
	if item.canHaveThreeEnchants and #item.enchantModLines > 1 then slots = 3 end
	if item.canHaveFourEnchants and #item.enchantModLines > 2 then slots = 4 end
	return { anointable = anointable and true or false, current = current, slots = slots, nodes = nodes }
end

M.set_item_anoint = function(p)
	ensureBuild()
	local item = requireItem(p)
	local node
	if p.nodeId ~= nil and p.nodeId ~= null then
		node = build.spec.tree.nodes[tonumber(p.nodeId)]
		if not node then error("unknown node id " .. tostring(p.nodeId), 0) end
	end
	local slot = tonumber(p and p.slot) or 1
	local newItem = new("Item"):Item(item:BuildRaw())
	newItem.id = item.id
	if #newItem.enchantModLines >= slot then table.remove(newItem.enchantModLines, slot) end
	if node then table.insert(newItem.enchantModLines, slot, { enchant = true, line = "Allocates " .. node.dn }) end
	newItem:BuildAndParseRaw()
	build.itemsTab:AddItem(newItem, true)
	build.itemsTab:PopulateSlots()
	build.itemsTab:AddUndoState()
	refresh()
	return M.item_anoints({ itemId = item.id })
end

-- ---------------------------------------------------------------------------
-- Corruptions, mirroring ItemsTab:CorruptDisplayItem: corrupted implicits
-- from data.itemMods.Corruption, and roll-range corruption for uniques.
-- ---------------------------------------------------------------------------

M.item_corruptions = function(p)
	ensureBuild()
	local item = requireItem(p)
	local isGlimpse = item.base and item.base.type == "Helmet" and item.title == "Glimpse of Chaos"
	local function modList(modType)
		local out = {}
		for modId, mod in pairs(data.itemMods.Corruption) do
			if mod.type == modType and (modType == "SpecialCorrupted" or item:GetModSpawnWeight(mod) > 0) then
				out[#out + 1] = { id = modId, label = table.concat(mod, "/"), group = opt(mod.group) }
			end
		end
		table.sort(out, function(a, b) return a.label < b.label end)
		return array(out)
	end
	local ranges = array({})
	if item.rarity == "UNIQUE" or item.rarity == "RELIC" then
		for i, mod in ipairs(item.explicitModLines) do
			local scaled = itemLib.applyRange(mod.line, mod.range or main.defaultItemAffixQuality, mod.valueScalar or 1, 2)
			if scaled ~= mod.line and item:CheckModLineVariant(mod) then
				ranges[#ranges + 1] = { index = i, line = mod.line, current = mod.corruptedRange or 1 }
			end
		end
	end
	return {
		corruptible = item.corruptible and true or false,
		corrupted = item.corrupted and true or false,
		enchantNum = isGlimpse and 8 or 2,
		mods = modList("Corrupted"),
		specialMods = isGlimpse and modList("SpecialCorrupted") or array({}),
		ranges = ranges,
	}
end

M.corrupt_item = function(p)
	ensureBuild()
	local item0 = requireItem(p)
	local item = new("Item"):Item(item0:BuildRaw())
	item.id = item0.id
	item.corrupted = true
	if p and p.modIds and #p.modIds > 0 then
		local newEnchant = {}
		for _, id in ipairs(p.modIds) do
			local mod = data.itemMods.Corruption[id]
			if not mod then error("unknown corruption mod " .. tostring(id), 0) end
			for i, modLine in ipairs(mod) do
				if mod.modTags[1] then
					newEnchant[#newEnchant + 1] = { line = "{tags:" .. table.concat(mod.modTags, ",") .. "}" .. modLine, enchant = true, order = mod.statOrder[i] }
				else
					newEnchant[#newEnchant + 1] = { line = modLine, enchant = true, order = mod.statOrder[i] }
				end
			end
		end
		-- keep anoints; corruption implicits replace any other enchants
		local keep = {}
		for _, m in ipairs(item.enchantModLines) do
			if m.line:match("Allocates .*") then keep[#keep + 1] = m end
		end
		item.enchantModLines = keep
		table.sort(newEnchant, function(a, b) return a.order < b.order end)
		for i, e in ipairs(newEnchant) do
			e.order = nil
			table.insert(item.enchantModLines, i, e)
		end
	end
	if p and p.ranges then
		for _, r in ipairs(p.ranges) do
			local ml = item.explicitModLines[tonumber(r.index) or -1]
			if ml then
				local v = tonumber(r.value) or 1
				ml.corruptedRange = v ~= 1 and v or nil
			end
		end
	end
	item:BuildAndParseRaw()
	build.itemsTab:AddItem(item, true)
	build.itemsTab:PopulateSlots()
	build.itemsTab:AddUndoState()
	refresh()
	return { ok = true }
end

-- ---------------------------------------------------------------------------
-- Shared items (main.sharedItemList): PoB stores these in its own settings
-- file, which this app never writes — the list read from the user's real
-- PoB settings is available here, and additions are restored app-side.
-- ---------------------------------------------------------------------------

M.get_shared_items = function()
	local items = array({})
	for i, item in ipairs(main.sharedItemList) do
		items[#items + 1] = {
			index = i,
			name = item.name or "?",
			baseName = opt(item.baseName),
			rarity = opt(item.rarity),
			raw = item:BuildRaw(),
		}
	end
	return { items = items }
end

M.add_shared_item = function(p)
	ensureBuild()
	local raw
	if p and p.itemId then
		raw = requireItem(p):BuildRaw()
	elseif p and p.raw then
		raw = p.raw
	else
		error("params.itemId or params.raw is required", 0)
	end
	local item = new("Item"):Item(raw)
	if not item.base then error("unrecognised item text", 0) end
	table.insert(main.sharedItemList, item)
	return M.get_shared_items()
end

M.remove_shared_item = function(p)
	local index = tonumber(p and p.index)
	if not index or not main.sharedItemList[index] then error("unknown shared item index", 0) end
	table.remove(main.sharedItemList, index)
	return M.get_shared_items()
end

M.equip_shared_item = function(p)
	ensureBuild()
	local index = tonumber(p and p.index)
	local shared = main.sharedItemList[index or -1]
	if not shared then error("unknown shared item index", 0) end
	return M.equip_item_raw({ text = shared:BuildRaw(), slot = p and p.slotName })
end

-- ---------------------------------------------------------------------------
-- Trade search generation: PoB's TradeQueryGenerator driven headless. The
-- weight scan is a coroutine, pumped in chunks like the tree power builder.
-- First use builds Data/QueryMods.lua (downloading GGG's trade stats via the
-- host's HTTP shim); it lands in the user cache overlay and is reused.
-- ---------------------------------------------------------------------------

local tradeGen, tradeState

M.trade_search_start = function(p)
	ensureBuild()
	local slot = build.itemsTab.slots[p and p.slotName or ""]
	if not slot then error("unknown slot " .. tostring(p and p.slotName), 0) end
	if not tradeGen then
		tradeGen = new("TradeQueryGenerator"):TradeQueryGenerator({ itemsTab = build.itemsTab })
	end
	tradeGen.itemsTab = build.itemsTab
	local weights = {}
	for _, w in ipairs((p and p.statWeights) or { { stat = "FullDPS", weightMult = 1 } }) do
		local found
		for _, s in ipairs(data.powerStatList) do
			if s.stat == w.stat then found = s break end
		end
		weights[#weights + 1] = {
			label = (found and found.label) or w.stat,
			stat = w.stat,
			transform = found and found.transform or nil,
			weightMult = tonumber(w.weightMult) or 1,
		}
	end
	local options = {
		statWeights = weights,
		includeCorrupted = p and p.includeCorrupted and true or false,
		includeRunes = p and p.includeRunes and true or false,
		includeMirrored = p and p.includeMirrored and true or false,
		maxLevel = tonumber(p and p.maxLevel),
		sockets = tonumber(p and p.sockets),
		jewelType = (p and p.jewelType) or "Sapphire",
	}
	tradeState = { done = false }
	tradeGen.requesterContext = nil
	tradeGen.requesterCallback = function(_, queryJson, errMsg)
		tradeState.done = true
		tradeState.query = queryJson
		tradeState.err = errMsg and tostring(errMsg) or nil
	end
	tradeGen:StartQuery(slot, options)
	if not tradeGen.calcContext or not tradeGen.calcContext.co then
		-- StartQuery bailed (unsupported slot/item type)
		if not tradeState.done then error("this slot's item type is not supported for trade search generation", 0) end
	end
	return { started = true }
end

M.trade_search_step = function(p)
	if not tradeState then error("no trade search in progress", 0) end
	local steps = tonumber(p and p.steps) or 40
	for _ = 1, steps do
		if tradeState.done or not tradeGen.calcContext or not tradeGen.calcContext.co then break end
		tradeGen:OnFrame()
	end
	if not tradeState.done and (not tradeGen.calcContext or not tradeGen.calcContext.co) then
		tradeGen:FinishQuery()
	end
	return { done = tradeState.done and true or false }
end

M.trade_search_result = function()
	if not tradeState or not tradeState.done then error("no finished trade search", 0) end
	if tradeState.err then error(tradeState.err, 0) end
	return { query = tradeState.query }
end

M.trade_leagues = function()
	local body, err = native.http_get("https://www.pathofexile.com/api/trade2/data/leagues", "Path of Building/" .. (launch and launch.versionNumber or "2"))
	if not body then error(err or "download failed", 0) end
	local decoded = dkjson.decode(body)
	local leagues = array({})
	for _, l in ipairs((decoded and decoded.result) or {}) do
		leagues[#leagues + 1] = { id = l.id, text = l.text or l.id }
	end
	if #leagues == 0 then error("league list unavailable", 0) end
	return { leagues = leagues }
end

-- ---------------------------------------------------------------------------
-- GGG Build Planner (*.build) import: JSON with passive stringIds, gem
-- metadata ids and gear hint text. Tree goes through PoB's own
-- ImportFromNodeList (weapon-set allocations included); gear hints land in
-- Notes. The class is inferred by walking the imported node set from each
-- class start.
-- ---------------------------------------------------------------------------

M.import_game_build = function(p)
	if not p or type(p.json) ~= "string" then error("params.json is required", 0) end
	-- strip a UTF-8 BOM; GGG writes plain UTF-8, other tools may not
	local jsonText = p.json:gsub("^\239\187\191", "")
	local dat, _, jsonErr = dkjson.decode(jsonText)
	if dat == nil then
		error("not a valid .build file: " .. tostring(jsonErr or "JSON parse failed"), 0)
	end
	if type(dat) ~= "table" or dat[1] ~= nil then
		error("not a valid .build file: the top level must be a single Build object", 0)
	end
	if dat.name ~= nil and type(dat.name) ~= "string" then
		error('not a valid .build file: "name" must be a string', 0)
	end
	-- The schema allows array entries to be plain id strings or objects with
	-- an `id`; validate both and collect precise problems instead of failing
	-- silently.
	local problems = {}
	local function checkArray(field)
		local v = dat[field]
		if v ~= nil and (type(v) ~= "table" or (next(v) ~= nil and v[1] == nil)) then
			problems[#problems + 1] = '"' .. field .. '" must be an array'
			dat[field] = nil
		end
	end
	checkArray("passives")
	checkArray("skills")
	checkArray("inventory_slots")
	local function entryId(v, where)
		if type(v) == "string" then return v, {} end
		if type(v) == "table" and type(v.id) == "string" then return v.id, v end
		problems[#problems + 1] = where .. ': expected an id string or an object with an "id" string'
		return nil
	end
	-- level_interval: [lo, hi] or a single level (taken as "from here on").
	-- Progression files list early-only entries; the import takes the final
	-- state, i.e. everything active at the highest level any entry reaches.
	local function interval(entry)
		local li = entry.level_interval
		if type(li) == "number" then return li, 100 end
		if type(li) == "table" and tonumber(li[1]) then return tonumber(li[1]), tonumber(li[2]) or 100 end
		return 0, 100
	end
	local targetLevel = 0
	for _, field in ipairs({ "passives", "skills" }) do
		for _, v in ipairs(dat[field] or {}) do
			if type(v) == "table" then
				local _, hi = interval(v)
				if hi > targetLevel then targetLevel = hi end
			end
		end
	end
	if targetLevel == 0 then targetLevel = 100 end
	local function activeAtTarget(entry)
		local lo, hi = interval(entry)
		return lo <= targetLevel and targetLevel <= hi
	end
	-- finish the unique-DB parse up front; gear import reads it, and pumping
	-- frames mid-import stalls the loader coroutine
	do
		local guard = 0
		while (main.uniqueDB.loading or main.rareDB.loading) and guard < 20000 do
			frame()
			guard = guard + 1
		end
	end
	M.new_build({ name = (p.name and p.name ~= "" and p.name) or dat.name or "Imported build" })
	local spec = build.spec
	local byString = {}
	for id, node in pairs(spec.tree.nodes) do
		if node.stringId then byString[node.stringId] = id end
	end
	-- A node listed without weapon_set is part of the base tree even if it is
	-- also listed for a set; only nodes that appear exclusively for one set
	-- become set-specific (PoB allocMode 1/2). Getting this wrong severs the
	-- base tree and PoB prunes everything downstream.
	local hashList, weaponSets, missing, seen = {}, {}, {}, {}
	local inBase, inSet = {}, {}
	for i, pass in ipairs(dat.passives or {}) do
		local pid, entry = entryId(pass, "passives[" .. i .. "]")
		if pid and not activeAtTarget(entry) then pid = nil end
		if pid then
			local nid = byString[pid]
			if nid then
				if not seen[nid] then
					seen[nid] = true
					hashList[#hashList + 1] = nid
				end
				local ws = tonumber(entry.weapon_set)
				if entry.weapon_set ~= nil and (not ws or ws < 0 or ws > 2) then
					problems[#problems + 1] = "passives[" .. i .. ']: "weapon_set" must be between 0 and 2'
					inBase[nid] = true
				elseif ws and ws > 0 then
					inSet[nid] = inSet[nid] or {}
					inSet[nid][ws] = true
				else
					inBase[nid] = true
				end
			else
				missing[#missing + 1] = pid
			end
		end
	end
	for nid, sets in pairs(inSet) do
		if not inBase[nid] and not (sets[1] and sets[2]) then
			weaponSets[nid] = sets[1] and 1 or 2
		end
	end
	-- class and ascendancy: explicit metadata wins; an imported ascendancy
	-- node pins both; otherwise BFS the imported set from each class start.
	-- Twin classes share a start node, so ties prefer PoE2-native classes
	-- over the legacy scaffolding classes still present in the tree data.
	-- How many imported nodes each class start can reach through the imported
	-- set. PoB deallocates anything not connected to the chosen start, so the
	-- class must match the tree even when the metadata says otherwise.
	local legacy = { Ranger = true, Duelist = true, Templar = true, Marauder = true, Shadow = true, Scion = true, Six = true }
	local reach, bestCid, bestReach, bestLegacy = {}, nil, -1, true
	local cids = {}
	for cid in pairs(spec.tree.classes) do
		if type(cid) == "number" then cids[#cids + 1] = cid end
	end
	table.sort(cids)
	for _, cid in ipairs(cids) do
		local class = spec.tree.classes[cid]
		if type(class) == "table" and class.startNodeId and spec.nodes[class.startNodeId] then
			local visited = { [class.startNodeId] = true }
			local queue, reached = { spec.nodes[class.startNodeId] }, 0
			while #queue > 0 do
				local node = table.remove(queue)
				for _, other in ipairs(node.linked or {}) do
					if not visited[other.id] and seen[other.id] then
						visited[other.id] = true
						reached = reached + 1
						queue[#queue + 1] = other
					end
				end
			end
			reach[cid] = reached
			local isLegacy = legacy[class.name] or false
			if reached > bestReach or (reached == bestReach and bestLegacy and not isLegacy) then
				bestReach, bestLegacy, bestCid = reached, isLegacy, cid
			end
		end
	end
	local function className(cid)
		local c = spec.tree.classes[cid]
		return (type(c) == "table" and c.name) or tostring(cid)
	end

	local classId, ascendClassId, classSource = nil, 0, nil
	local wantedAscend = dat.ascendancy or dat.ascendancy_class
	if type(wantedAscend) == "string" then
		-- display name ("Gemling Legionnaire") or the game's internal id ("Mercenary3")
		local m = (spec.tree.ascendNameMap and spec.tree.ascendNameMap[wantedAscend])
			or (spec.tree.internalAscendNameMap and spec.tree.internalAscendNameMap[wantedAscend])
		if m and m.classId and m.ascendClassId then
			classId, ascendClassId, classSource = m.classId, m.ascendClassId, '"ascendancy" ' .. wantedAscend
		else
			problems[#problems + 1] = '"ascendancy": unknown ascendancy ' .. wantedAscend .. " (inferred from the tree instead)"
		end
	end
	if not classId then
		for nid in pairs(seen) do
			local node = spec.nodes[nid]
			if node and node.ascendancyName and spec.tree.ascendNameMap and spec.tree.ascendNameMap[node.ascendancyName] then
				local m = spec.tree.ascendNameMap[node.ascendancyName]
				classId, ascendClassId, classSource = m.classId, m.ascendClassId, "its " .. node.ascendancyName .. " passives"
				break
			end
		end
	end
	if classId and bestCid and #hashList > 0 and (reach[classId] or 0) * 2 < bestReach then
		problems[#problems + 1] = string.format(
			"%s says %s, but the passives connect to the %s start (%d of %d reachable vs %d) — imported as %s without an ascendancy; the file's class label is wrong or the tree is",
			classSource, className(classId), className(bestCid), reach[classId] or 0, #hashList, bestReach, className(bestCid))
		classId, ascendClassId = bestCid, 0
	end
	classId = classId or bestCid or build.classId or 0
	spec:ImportFromNodeList(nil, classId, ascendClassId, 0, hashList, weaponSets, {}, {}, latestTreeVersion)
	spec:AddUndoState()
	-- PoB prunes nodes it cannot connect to the class start; report rather
	-- than pretend they were allocated
	local allocatedCount, normalPoints, prunedNames = 0, 0, {}
	for _, nid in ipairs(hashList) do
		local node = spec.allocNodes[nid]
		if node then
			allocatedCount = allocatedCount + 1
			if not node.ascendancyName and node.type ~= "ClassStart" and (node.allocMode or 0) == 0 then
				normalPoints = normalPoints + 1
			end
		elseif #prunedNames < 5 then
			prunedNames[#prunedNames + 1] = (spec.nodes[nid] and spec.nodes[nid].dn) or tostring(nid)
		end
	end
	local pruned = #hashList - allocatedCount
	if pruned > 0 then
		problems[#problems + 1] = string.format(
			"%d of %d passives could not be connected to the tree from the %s start and were dropped by PoB (%s%s)",
			pruned, #hashList, className(classId), table.concat(prunedNames, ", "), pruned > #prunedNames and ", …" or "")
	end
	-- the format carries no character level; estimate one from the points
	-- spent (quest points come along the way, so points ≈ level early on)
	if normalPoints > 0 then
		build.characterLevel = math.min(100, math.max(1, normalPoints + 1))
		build.characterLevelAutoMode = false
	end
	-- skills: one socket group per entry. The game references BaseItemTypes
	-- ids; PoB keys some gems (notably supports) under internal ids with the
	-- game's id in `gameId`, so resolve through both.
	local gameIdIndex
	local function findGem(gid)
		gid = tostring(gid or "")
		if data.gems[gid] then return gid end
		if not gameIdIndex then
			gameIdIndex = {}
			for key, gem in pairs(data.gems) do
				if gem.gameId and not gameIdIndex[gem.gameId] then gameIdIndex[gem.gameId] = key end
			end
		end
		if gameIdIndex[gid] then return gameIdIndex[gid] end
		for _, alt in ipairs({ (gid:gsub("/Gems/", "/Gem/")), (gid:gsub("/Gem/", "/Gems/")) }) do
			if data.gems[alt] then return alt end
			if gameIdIndex[alt] then return gameIdIndex[alt] end
		end
	end
	local addedGroups, missingSkills = 0, {}
	-- planners often list a gem twice (socketed setup plus a bare mention);
	-- a bare repeat of an active already imported is dropped
	local seenActive = {}
	for i, sk in ipairs(dat.skills or {}) do
		local skId, skEntry = entryId(sk, "skills[" .. i .. "]")
		if skId and not activeAtTarget(skEntry) then skId = nil end
		local gid = skId and findGem(skId)
		local supports = type(skEntry and skEntry.support_skills) == "table" and skEntry.support_skills or {}
		if gid and seenActive[gid] and #supports == 0 then gid = nil end
		if gid then
			seenActive[gid] = true
			local group = { label = "", enabled = true, gemList = {} }
			local function addGem(id)
				local gemData = data.gems[id]
				local gem = {
					level = 1,
					quality = build.skillsTab.defaultGemQuality or 0,
					enabled = true,
					enableGlobal1 = true,
					enableGlobal2 = true,
					gemId = id,
					nameSpec = gemData.name,
					skillId = gemData.grantedEffectId,
				}
				gem.level = build.skillsTab:ProcessGemLevel(gemData)
				group.gemList[#group.gemList + 1] = gem
			end
			addGem(gid)
			if skEntry.support_skills ~= nil and type(skEntry.support_skills) ~= "table" then
				problems[#problems + 1] = "skills[" .. i .. ']: "support_skills" must be an array'
			end
			for j, sup in ipairs(type(skEntry.support_skills) == "table" and skEntry.support_skills or {}) do
				local supId = entryId(sup, "skills[" .. i .. "].support_skills[" .. j .. "]")
				local sgid = supId and findGem(supId)
				if sgid then addGem(sgid) elseif supId then missingSkills[#missingSkills + 1] = supId end
			end
			table.insert(build.skillsTab.socketGroupList, group)
			build.skillsTab:ProcessSocketGroup(group)
			addedGroups = addedGroups + 1
		elseif skId then
			missingSkills[#missingSkills + 1] = skId
		end
	end
	if addedGroups > 0 then
		build.mainSocketGroup = 1
		build.skillsTab:AddUndoState()
	end
	-- the format has no "main skill"; pick the socket group PoB rates highest
	-- for damage (auras, buffs and item-granted groups never win by accident)
	local function pickMainSkill()
		local candidates = {}
		for i, group in ipairs(build.skillsTab.socketGroupList) do
			if group.enabled and not group.source then candidates[#candidates + 1] = i end
		end
		if #candidates <= 1 then
			build.mainSocketGroup = candidates[1] or build.mainSocketGroup
			return
		end
		local best, bestDps = candidates[1], -1
		for _, i in ipairs(candidates) do
			build.mainSocketGroup = i
			build.buildFlag = true
			frame()
			local o = build.calcsTab.mainOutput
			local dps = o and (o.CombinedDPS or o.TotalDPS or 0) or 0
			if dps > bestDps then bestDps, best = dps, i end
		end
		build.mainSocketGroup = best
	end
	-- gear: the format carries text hints, but they usually name a base plus
	-- numbered mod lines (and unique_name for uniques) — enough to build real
	-- items through PoB's parser. Uniques come from PoB's own unique DB when
	-- the name matches. Only unresolvable hints fall back to Notes.
	local invMapIn = {
		Weapon1 = "Weapon 1",
		Offhand1 = "Weapon 2",
		Weapon2 = "Weapon 1 Swap",
		Offhand2 = "Weapon 2 Swap",
		Helm1 = "Helmet",
		BodyArmour1 = "Body Armour",
		Gloves1 = "Gloves",
		Boots1 = "Boots",
		Belt1 = "Belt",
		Amulet1 = "Amulet",
		Ring1 = "Ring 1",
		Ring2 = "Ring 2",
	}
	local gearAdded, gearHints = 0, {}
	local uniqueByTitle
	local function findUnique(title)
		if main.uniqueDB.loading then return nil end
		if not uniqueByTitle then
			-- the unique DB is keyed "Name, Base"
			uniqueByTitle = {}
			for key, dbItem in pairs(main.uniqueDB.list) do
				local t = key:match("^(.-),%s") or key
				if not uniqueByTitle[t] then uniqueByTitle[t] = dbItem end
			end
		end
		-- authors sometimes annotate the name, e.g. "Darkness Enthroned (gloves)"
		return uniqueByTitle[title] or main.uniqueDB.list[title] or uniqueByTitle[(title:gsub("%s*%b()%s*$", ""))]
	end
	for i, slot in ipairs(type(dat.inventory_slots) == "table" and dat.inventory_slots or {}) do
		if type(slot) ~= "table" then
			problems[#problems + 1] = "inventory_slots[" .. i .. "]: expected an object"
		else
			local iid = tostring(slot.inventory_id or "")
			local sx = tonumber(slot.slot_x) or 0
			local slotName = invMapIn[iid]
			if not slotName and iid == "Flask1" then slotName = "Flask " .. (sx + 1) end
			if not slotName and iid == "Charm1" then slotName = "Charm " .. (sx + 1) end
			local text = tostring(slot.additional_text or "")
			local lines = {}
			for line in (text .. "\n"):gmatch("(.-)\n") do
				line = line:match("^%s*(.-)%s*$")
				if line ~= "" then lines[#lines + 1] = line end
			end
			local baseName = lines[1]
			local mods = {}
			for j = 2, #lines do
				mods[#mods + 1] = (lines[j]:gsub("^%d+[%.%)]%s*", ""))
			end
			local item
			local uniqueName = type(slot.unique_name) == "string" and slot.unique_name ~= "" and slot.unique_name or nil
			if uniqueName then
				local dbItem = findUnique(uniqueName)
				if dbItem then
					item = new("Item"):Item(dbItem:BuildRaw())
				elseif baseName then
					item = new("Item"):Item("Rarity: UNIQUE\n" .. uniqueName .. "\n" .. baseName .. "\n" .. table.concat(mods, "\n"))
				end
			elseif baseName then
				item = new("Item"):Item("Rarity: RARE\nImported " .. baseName .. "\n" .. baseName .. "\n" .. table.concat(mods, "\n"))
			end
			if item and item.base then
				build.itemsTab:AddItem(item, true)
				if slotName and build.itemsTab.slots[slotName] and build.itemsTab:IsItemValidForSlot(item, slotName) then
					build.itemsTab.slots[slotName]:SetSelItemId(item.id)
				end
				gearAdded = gearAdded + 1
			elseif #lines > 0 or uniqueName then
				gearHints[#gearHints + 1] = { id = iid, unique = uniqueName, text = text }
			end
		end
	end
	if gearAdded > 0 then
		build.itemsTab:PopulateSlots()
		build.itemsTab:AddUndoState()
	end
	local notes = {}
	if dat.author then notes[#notes + 1] = "Author: " .. tostring(dat.author) end
	if dat.link then notes[#notes + 1] = "Link: " .. tostring(dat.link) end
	if dat.description then notes[#notes + 1] = tostring(dat.description) end
	if #gearHints > 0 then
		notes[#notes + 1] = ""
		notes[#notes + 1] = "== Gear hints that could not be turned into items =="
		for _, hint in ipairs(gearHints) do
			notes[#notes + 1] = ""
			notes[#notes + 1] = "[" .. hint.id .. "]"
			if hint.unique then notes[#notes + 1] = hint.unique end
			notes[#notes + 1] = hint.text
		end
	end
	if #notes > 0 then M.set_notes({ text = table.concat(notes, "\n") }) end
	if addedGroups > 0 then pickMainSkill() end
	refresh()
	return {
		info = M.get_build(),
		allocated = allocatedCount,
		requested = #hashList,
		missingPassives = strArray(missing),
		skillGroups = addedGroups,
		missingSkills = strArray(missingSkills),
		gearItems = gearAdded,
		gearHints = #gearHints,
		warnings = strArray(problems),
	}
end

-- Export the current build as a Build Planner *.build JSON. Only slot ids the
-- game's format is known to accept are emitted for gear hints.
M.export_game_build = function()
	ensureBuild()
	local out = { name = build.buildName or "PoB Redux build" }
	if (build.spec.curAscendClassId or 0) > 0 and build.ascendClassName and build.ascendClassName ~= "None" then
		out.ascendancy = build.ascendClassName
	end
	local passives = {}
	for _, node in pairs(build.spec.allocNodes) do
		if node.stringId and node.type ~= "ClassStart" and node.type ~= "AscendClassStart" then
			local entry = { id = node.stringId }
			if node.allocMode and node.allocMode > 0 then entry.weapon_set = node.allocMode end
			passives[#passives + 1] = entry
		end
	end
	table.sort(passives, function(a, b) return a.id < b.id end)
	out.passives = passives
	local skills = {}
	for _, group in ipairs(build.skillsTab.socketGroupList) do
		if group.enabled and not group.source then
			local actives, supports = {}, {}
			for _, gem in ipairs(group.gemList) do
				local gd = gem.gemData
				if gem.enabled and gd and (gd.gameId or gd.id) then
					local gid = gd.gameId or gd.id
					if gd.gemType == "Support" or (gd.grantedEffect and gd.grantedEffect.support) then
						supports[#supports + 1] = { id = gid }
					else
						actives[#actives + 1] = { id = gid }
					end
				end
			end
			for _, a in ipairs(actives) do
				if #supports > 0 then a.support_skills = supports end
				skills[#skills + 1] = a
			end
		end
	end
	out.skills = skills
	local invMap = {
		["Weapon 1"] = "Weapon1",
		["Helmet"] = "Helm1",
		["Body Armour"] = "BodyArmour1",
		["Gloves"] = "Gloves1",
		["Boots"] = "Boots1",
		["Belt"] = "Belt1",
		["Amulet"] = "Amulet1",
		["Ring 1"] = "Ring1",
		["Ring 2"] = "Ring2",
	}
	local inventory = {}
	for slotName, slot in pairs(build.itemsTab.slots) do
		local item = slot.selItemId and slot.selItemId ~= 0 and build.itemsTab.items[slot.selItemId]
		if item and not slot.nodeId then
			local invId, sx = invMap[slotName], 0
			local flaskNum = slotName:match("^Flask (%d)")
			if not invId and flaskNum then
				invId = "Flask1"
				sx = tonumber(flaskNum) - 1
			end
			if invId then
				local entry = { inventory_id = invId, slot_x = sx, slot_y = 0 }
				if item.rarity == "UNIQUE" or item.rarity == "RELIC" then
					entry.unique_name = item.title or item.name
					entry.additional_text = item.baseName
				else
					local lines = { item.baseName or item.name }
					for i, mod in ipairs(item.explicitModLines or {}) do
						lines[#lines + 1] = i .. ". " .. mod.line:gsub("^{.-}", "")
					end
					entry.additional_text = table.concat(lines, "\n")
				end
				inventory[#inventory + 1] = entry
			end
		end
	end
	table.sort(inventory, function(a, b)
		if a.inventory_id ~= b.inventory_id then return a.inventory_id < b.inventory_id end
		return (a.slot_x or 0) < (b.slot_x or 0)
	end)
	out.inventory_slots = inventory
	return { json = dkjson.encode(out), name = out.name, passives = #passives, skills = #skills, gear = #inventory }
end

-- Weapon set I/II, including PoB's main-skill hand-off to a group socketed in
-- the newly active set.
M.set_weapon_set = function(p)
	ensureBuild()
	local wantSecond = tonumber(p and p.set) == 2
	local itemsTab = build.itemsTab
	if itemsTab.activeItemSet.useSecondWeaponSet == wantSecond then
		return M.list_slots()
	end
	itemsTab.activeItemSet.useSecondWeaponSet = wantSecond
	itemsTab:AddUndoState()
	local from, to = wantSecond and 1 or 2, wantSecond and 2 or 1
	local mainSocketGroup = build.skillsTab.socketGroupList[build.mainSocketGroup]
	if mainSocketGroup and mainSocketGroup.slot and itemsTab.slots[mainSocketGroup.slot] and itemsTab.slots[mainSocketGroup.slot].weaponSet == from then
		for index, socketGroup in ipairs(build.skillsTab.socketGroupList) do
			if socketGroup.slot and itemsTab.slots[socketGroup.slot] and itemsTab.slots[socketGroup.slot].weaponSet == to then
				build.mainSocketGroup = index
				break
			end
		end
	end
	refresh()
	return M.list_slots()
end

-- ---------------------------------------------------------------------------
-- Configuration
-- ---------------------------------------------------------------------------

local configOptionsCache
M.list_config_options = function()
	if not configOptionsCache then
		local varList = LoadModule("Modules/ConfigOptions")
		local options = array({})
		local section = null
		for _, o in ipairs(varList) do
			if o.section then
				section = o.section
			elseif o.var then
				local entry = {
					var = o.var,
					label = opt(o.label),
					type = opt(o.type),
					section = section,
					tooltip = opt(o.tooltip),
					defaultState = opt(o.defaultState),
					ifSkill = o.ifSkill and (type(o.ifSkill) == "table" and strArray(o.ifSkill) or o.ifSkill) or null,
					ifFlag = o.ifFlag and (type(o.ifFlag) == "table" and strArray(o.ifFlag) or o.ifFlag) or null,
					ifCond = o.ifCond and (type(o.ifCond) == "table" and strArray(o.ifCond) or o.ifCond) or null,
					ifMod = o.ifMod and (type(o.ifMod) == "table" and strArray(o.ifMod) or o.ifMod) or null,
				}
				if o.list then
					local list = array({})
					for _, e in ipairs(o.list) do
						list[#list + 1] = { val = e.val == nil and null or (isScalar(e.val) and e.val or tostring(e.val)), label = e.label }
					end
					entry.list = list
				end
				options[#options + 1] = entry
			end
		end
		configOptionsCache = { options = options }
	end
	return configOptionsCache
end

M.get_config = function()
	ensureBuild()
	local configTab = build.configTab
	local set = configTab.configSets[configTab.activeConfigSetId]
	local config, placeholder = {}, {}
	for key, value in pairs(set.input) do
		if isScalar(value) then config[key] = value end
	end
	for key, value in pairs(set.placeholder or {}) do
		if isScalar(value) then placeholder[key] = value end
	end
	local sets = array({})
	for _, id in ipairs(configTab.configSetOrderList) do
		local s = configTab.configSets[id]
		if s then
			sets[#sets + 1] = { id = id, title = opt(s.title), active = id == configTab.activeConfigSetId }
		end
	end
	return { config = config, placeholder = placeholder, activeConfigSet = configTab.activeConfigSetId, sets = sets }
end

M.set_config = function(p)
	ensureBuild()
	if not p or not p.var then error("params.var is required", 0) end
	local configTab = build.configTab
	local input = configTab.configSets[configTab.activeConfigSetId].input
	if p.value == nil or p.value == null then
		input[p.var] = nil
	else
		input[p.var] = p.value
	end
	configTab:BuildModList()
	configTab.modFlag = true
	refresh()
	return M.get_config()
end

M.select_config_set = function(p)
	ensureBuild()
	local id = tonumber(p and p.id)
	if not id or not build.configTab.configSets[id] then error("unknown config set id " .. tostring(p and p.id), 0) end
	build.configTab:SetActiveConfigSet(id)
	refresh()
	return M.get_config()
end

M.create_config_set = function(p)
	ensureBuild()
	local set = build.configTab:NewConfigSet(nil, (p and p.title) or "New Set")
	build.configTab:SetActiveConfigSet(set.id)
	refresh()
	return M.get_config()
end

M.copy_config_set = function(p)
	ensureBuild()
	local src = tonumber(p and p.id) or build.configTab.activeConfigSetId
	if not build.configTab.configSets[src] then error("unknown config set id", 0) end
	local set = build.configTab:CopyConfigSet(src, p and p.title)
	build.configTab:SetActiveConfigSet(set.id)
	refresh()
	return M.get_config()
end

M.rename_config_set = function(p)
	ensureBuild()
	local id = tonumber(p and p.id)
	if not id or not build.configTab.configSets[id] then error("unknown config set id", 0) end
	if not p.title then error("params.title is required", 0) end
	build.configTab:RenameConfigSet(id, p.title)
	return M.get_config()
end

M.delete_config_set = function(p)
	ensureBuild()
	local id = tonumber(p and p.id)
	if not id or not build.configTab.configSets[id] then error("unknown config set id", 0) end
	if #build.configTab.configSetOrderList <= 1 then error("cannot delete the only config set", 0) end
	local orderIndex
	for i, sid in ipairs(build.configTab.configSetOrderList) do
		if sid == id then orderIndex = i break end
	end
	build.configTab:DeleteConfigSet(id, orderIndex)
	build.configTab:SetActiveConfigSet()
	refresh()
	return M.get_config()
end

-- ---------------------------------------------------------------------------
-- Loadouts: PoB's named (tree, item set, skill set, config set) groupings.
-- A loadout exists where set titles match exactly or share a {linkId} tag.
-- ---------------------------------------------------------------------------

M.get_loadouts = function()
	ensureBuild()
	build:SyncLoadouts(true)
	local names = array({})
	for _, entry in ipairs(build.controls.buildLoadouts.list) do
		if type(entry) == "string" and not entry:match("^%^7%^7") and entry ~= "No Loadouts" then
			names[#names + 1] = entry
		end
	end
	local active = build.activeLoadout or 0
	return { loadouts = names, active = names[active] or null }
end

M.select_loadout = function(p)
	ensureBuild()
	if not p or not p.name then error("params.name is required", 0) end
	local loadout = build:GetLoadoutByName(p.name)
	if not loadout then error("unknown loadout " .. tostring(p.name), 0) end
	build:SetActiveLoadout(loadout)
	refresh()
	return M.get_loadouts()
end

M.new_loadout = function(p)
	ensureBuild()
	if not p or not p.name then error("params.name is required", 0) end
	build:NewLoadout(p.name)
	refresh()
	return M.get_loadouts()
end

M.copy_loadout = function(p)
	ensureBuild()
	if not p or not p.source or not p.name then error("params.source and params.name are required", 0) end
	build:CopyLoadout(p.source, p.name)
	refresh()
	return M.get_loadouts()
end

M.rename_loadout = function(p)
	ensureBuild()
	if not p or not p.name or not p.newName then error("params.name and params.newName are required", 0) end
	build:RenameLoadout(p.name, p.newName)
	build:SyncLoadouts(true)
	refresh()
	return M.get_loadouts()
end

M.delete_loadout = function(p)
	ensureBuild()
	if not p or not p.name then error("params.name is required", 0) end
	local state = M.get_loadouts()
	local nextName
	for _, n in ipairs(state.loadouts) do
		if n ~= p.name then nextName = n break end
	end
	if not nextName then error("cannot delete the only loadout", 0) end
	build:DeleteLoadout(p.name, nextName)
	refresh()
	return M.get_loadouts()
end

-- ---------------------------------------------------------------------------
-- Party tab: imported support-build buffs (auras, curses, warcries, links,
-- party member stats, enemy conditions/mods), driven exactly like PoB's
-- PartyTab buttons drive it.
-- ---------------------------------------------------------------------------

local partyKinds = {
	partyMemberStats = { ctl = "editPartyMemberStats" },
	auras = { ctl = "editAuras", simple = "simpleAuras" },
	warcries = { ctl = "editWarcries", simple = "simpleWarcries" },
	links = { ctl = "editLinks", simple = "simpleLinks" },
	enemyConditions = { ctl = "enemyCond", simple = "simpleEnemyCond" },
	enemyMods = { ctl = "enemyMods", simple = "simpleEnemyMods" },
	curses = { ctl = "editCurses", simple = "simpleCurses" },
}

local function partyWipeActor(pt)
	wipeTable(pt.actor)
	wipeTable(pt.enemyModList)
	pt.actor = { Aura = {}, Curse = {}, Warcry = {}, Link = {}, modDB = new("ModDB"):ModDB(), output = {} }
	pt.actor.modDB.actor = pt.actor
	pt.enemyModList = new("ModList"):ModList()
end

-- PoB's "Rebuild All" button: reparse every buffer into the party actor.
local function partyRebuild(pt)
	partyWipeActor(pt)
	pt:ParseBuffs(pt.actor["modDB"], pt.controls.editPartyMemberStats.buf, "PartyMemberStats", pt.actor["output"])
	pt:ParseBuffs(pt.actor["Aura"], pt.controls.editAuras.buf, "Aura", pt.controls.simpleAuras)
	pt:ParseBuffs(pt.actor["Curse"], pt.controls.editCurses.buf, "Curse", pt.controls.simpleCurses)
	pt:ParseBuffs(pt.actor["Warcry"], pt.controls.editWarcries.buf, "Warcry", pt.controls.simpleWarcries)
	pt:ParseBuffs(pt.actor["Link"], pt.controls.editLinks.buf, "Link", pt.controls.simpleLinks)
	pt:ParseBuffs(pt.enemyModList, pt.controls.enemyCond.buf, "EnemyConditions")
	pt:ParseBuffs(pt.enemyModList, pt.controls.enemyMods.buf, "EnemyMods", pt.controls.simpleEnemyMods)
	build.buildFlag = true
end

M.get_party = function()
	ensureBuild()
	local pt = build.partyTab
	local out = {}
	for key, def in pairs(partyKinds) do
		out[key] = {
			text = pt.controls[def.ctl].buf or "",
			summary = def.simple and (pt.controls[def.simple].label or "") or "",
		}
	end
	out.enableExportBuffs = pt.enableExportBuffs and true or false
	return out
end

M.set_party_text = function(p)
	ensureBuild()
	local def = partyKinds[p and p.kind or ""]
	if not def then error("unknown party kind " .. tostring(p and p.kind), 0) end
	build.partyTab.controls[def.ctl]:SetText(p.text or "")
	partyRebuild(build.partyTab)
	refresh()
	return M.get_party()
end

-- Import a support build's exported buffs (its share code) into the party tab.
-- Mirrors finishImport with destination "All".
M.party_import = function(p)
	ensureBuild()
	local xmlText = p and p.xml
	if not xmlText then
		local code = p and p.code
		if not code then error("params.code or params.xml is required", 0) end
		xmlText = Inflate(common.base64.decode(code:gsub("-", "+"):gsub("_", "/")))
		if not xmlText then error("could not decode the build code", 0) end
	end
	local dbXML, errMsg = common.xml.ParseXML(xmlText)
	if not dbXML then error("could not parse build XML: " .. tostring(errMsg), 0) end
	if dbXML[1].elem ~= "PathOfBuilding2" then error("'PathOfBuilding2' root element missing", 0) end
	local pt = build.partyTab
	local append = p and p.append and true or false
	if not append then
		for _, def in pairs(partyKinds) do
			pt.controls[def.ctl]:SetText("")
		end
	end
	local names = {
		["PartyMemberStats"] = "editPartyMemberStats",
		["Aura"] = "editAuras",
		["Curse"] = "editCurses",
		["Warcry Skills"] = "editWarcries",
		["Link Skills"] = "editLinks",
		["EnemyConditions"] = "enemyCond",
		["EnemyMods"] = "enemyMods",
	}
	local found = false
	for _, tabNode in ipairs(dbXML[1]) do
		if type(tabNode) == "table" and tabNode.elem == "Party" then
			for _, node in ipairs(tabNode) do
				if node.elem == "ExportedBuffs" and node.attrib.name and names[node.attrib.name] then
					found = true
					local ctl = pt.controls[names[node.attrib.name]]
					local text = node[1] or ""
					if append and #ctl.buf > 0 then
						text = ctl.buf .. "\n" .. text
					end
					ctl:SetText(text)
				end
			end
			break
		end
	end
	if not found then
		error("that build has no exported support buffs (export it with \"Export support\" enabled)", 0)
	end
	partyRebuild(pt)
	refresh()
	return M.get_party()
end

M.party_clear = function()
	ensureBuild()
	local pt = build.partyTab
	for _, def in pairs(partyKinds) do
		pt.controls[def.ctl]:SetText("")
	end
	for _, def in pairs(partyKinds) do
		if def.simple then pt.controls[def.simple].label = "" end
	end
	partyWipeActor(pt)
	build.buildFlag = true
	refresh()
	return M.get_party()
end

M.party_rebuild = function()
	ensureBuild()
	partyRebuild(build.partyTab)
	refresh()
	return M.get_party()
end

M.party_set_export = function(p)
	ensureBuild()
	build.partyTab.enableExportBuffs = p and p.enabled and true or false
	build.buildFlag = true
	refresh()
	return M.get_party()
end

-- ---------------------------------------------------------------------------
-- App options that live on PoB's `main` (never saved via SaveSettings; the
-- frontend persists them and re-applies on boot).
-- ---------------------------------------------------------------------------

local appOptionKeys = {
	showThousandsSeparators = "boolean",
	thousandsSeparator = "string",
	decimalSeparator = "string",
	defaultGemQuality = "number",
	defaultCharLevel = "number",
	defaultItemAffixQuality = "number",
}

M.get_app_options = function()
	local out = {}
	for key in pairs(appOptionKeys) do
		local v = main[key]
		out[key] = v == nil and null or v
	end
	return { options = out }
end

M.set_app_options = function(p)
	if not p then error("params are required", 0) end
	for key, wanted in pairs(appOptionKeys) do
		local v = p[key]
		if v ~= nil and v ~= null then
			if type(v) ~= wanted then error(key .. " must be a " .. wanted, 0) end
			main[key] = v
		end
	end
	if build then refresh() end
	return M.get_app_options()
end

-- ---------------------------------------------------------------------------
-- Custom modifiers (per config set)
-- ---------------------------------------------------------------------------

local function customModsList()
	local configTab = build.configTab
	local set = configTab.configSets[configTab.activeConfigSetId]
	if not set.customModsList then set.customModsList = {} end
	if #set.customModsList == 0 then
		table.insert(set.customModsList, { title = "Default", enabled = true, text = (set.input and set.input.customMods) or "" })
	end
	return set.customModsList
end

local function customModsChanged()
	local configTab = build.configTab
	pcall(function() configTab:UpdateCustomModsControls() end)
	configTab:AddUndoState()
	configTab:BuildModList()
	refresh()
end

M.get_custom_mods = function()
	ensureBuild()
	local blocks = array({})
	for i, block in ipairs(customModsList()) do
		local lines = array({})
		for line in ((block.text or "") .. "\n"):gmatch("(.-)\n") do
			local trimmed = line:match("^%s*(.-)%s*$")
			local status = "empty"
			if #trimmed > 0 then
				local modList, extra = modLib.parseMod(trimmed)
				status = modList and (extra and "partial" or "ok") or "none"
			end
			lines[#lines + 1] = { text = line, status = status }
		end
		-- drop the trailing empty line the split produces
		if #lines > 0 and lines[#lines].text == "" then lines[#lines] = nil end
		blocks[#blocks + 1] = {
			index = i,
			title = opt(block.title),
			enabled = block.enabled and true or false,
			text = block.text or "",
			lines = lines,
		}
	end
	return { blocks = blocks }
end

M.set_custom_mod_block = function(p)
	ensureBuild()
	local blocks = customModsList()
	local block = blocks[tonumber(p and p.index) or -1]
	if not block then error("unknown custom mod block index", 0) end
	if p.title ~= nil and p.title ~= null then block.title = p.title end
	if p.enabled ~= nil and p.enabled ~= null then block.enabled = p.enabled and true or false end
	if p.text ~= nil and p.text ~= null then block.text = p.text end
	customModsChanged()
	return M.get_custom_mods()
end

M.add_custom_mod_block = function(p)
	ensureBuild()
	local blocks = customModsList()
	table.insert(blocks, { title = (p and p.title) or ("Group " .. (#blocks + 1)), enabled = true, text = "" })
	customModsChanged()
	return M.get_custom_mods()
end

M.delete_custom_mod_block = function(p)
	ensureBuild()
	local blocks = customModsList()
	local index = tonumber(p and p.index)
	if not index or not blocks[index] then error("unknown custom mod block index", 0) end
	table.remove(blocks, index)
	customModsChanged()
	return M.get_custom_mods()
end

-- Supported example mod lines for the custom-mod browser: the same collection
-- PoB's Mod Browser popup builds (Modules/ConfigModBrowser.lua) — tree node
-- stats plus item/crafted/veiled mod pools — filtered to parseable lines.
local modBrowserCache
M.custom_mod_browser = function()
	ensureBuild()
	local treeVersion = build.spec and build.spec.treeVersion or "?"
	if modBrowserCache and modBrowserCache.version == treeVersion then
		return modBrowserCache.result
	end
	local modSet = {}
	local function templateOf(text)
		return text
			:gsub("([%+-]?)%((%-?%d+%.?%d*)%-(%-?%d+%.?%d*)%)", "%1#")
			:gsub("%d+%.?%d*", "#")
			:lower()
	end
	local function addModLine(line, source, supported)
		local template = templateOf(line)
		local entry = modSet[template]
		if not entry then
			entry = { text = line, sources = {}, template = template }
			modSet[template] = entry
		end
		entry.sources[source] = true
		if supported ~= nil then
			if supported and not entry.supported then entry.text = line end
			entry.supported = entry.supported or supported
		end
	end
	local seenGroups = {}
	local function addItemMod(mod, source)
		if seenGroups[mod.group] then return end
		seenGroups[mod.group] = true
		if mod.tradeHashes then
			for _, statDescription in pairs(mod.tradeHashes) do
				local line = table.concat(statDescription, " ")
				local rangedLine = itemLib.applyRange(line, 0.5)
				local modList, extra = modLib.parseMod(rangedLine)
				addModLine(rangedLine, source, (not not modList) and not extra)
			end
		else
			for _, line in ipairs(mod) do
				local rangedLine = itemLib.applyRange(line, 0.5)
				local modList, extra = modLib.parseMod(rangedLine)
				addModLine(rangedLine, source, (not not modList) and not extra)
			end
		end
	end
	local tree = build.spec.tree
	for _, node in pairs(tree.nodes) do
		if node.type == "Mastery" and node.masteryEffects then
			for _, masteryEffect in ipairs(node.masteryEffects) do
				for _, statLine in ipairs(masteryEffect.stats) do
					local modList, extra = modLib.parseMod(statLine)
					addModLine(statLine, string.format("%s Node", node.type), (not not modList) and not extra)
				end
			end
		elseif node.stats and node.mods then
			local i = 1
			while node.stats[i] do
				local combinedLine = node.stats[i]
				while node.mods[i + 1] do
					if node.mods[i + 1].combined then
						combinedLine = combinedLine .. " " .. node.stats[i + 1]
						i = i + 1
					else
						break
					end
				end
				local supported = not not node.mods[i].list and not node.mods[i].extra
				local ascendancyPrefix = node.isBloodline and "Bloodline " or node.ascendancyName and "Ascendancy " or ""
				addModLine(combinedLine, string.format("%s%s Node", ascendancyPrefix, node.type), supported)
				i = i + 1
			end
		end
	end
	local bData = build.data
	if bData.masterMods then
		for _, mod in ipairs(bData.masterMods) do addItemMod(mod, "Crafted mod") end
	end
	local ignoredCats = { Item = true, Runes = true }
	if bData.itemMods then
		for catName, catMods in pairs(bData.itemMods) do
			if not ignoredCats[catName] and type(catMods) == "table" then
				for _, mod in pairs(catMods) do addItemMod(mod, "Item mod") end
			end
		end
	end
	if bData.veiledMods then
		for _, mod in pairs(bData.veiledMods) do addItemMod(mod, "Veiled mod") end
	end
	if bData.beastCraft then
		for _, mod in pairs(bData.beastCraft) do addItemMod(mod, "Item mod") end
	end
	local supportedList = {}
	for template, mod in pairs(modSet) do
		if mod.supported then
			mod.sortKey = template:gsub("#", " "):gsub("[^%a]+", " "):match("^%s*(.-)%s*$")
			table.insert(supportedList, mod)
		end
	end
	table.sort(supportedList, function(a, b)
		if a.sortKey ~= b.sortKey then return a.sortKey < b.sortKey end
		if a.template ~= b.template then return a.template < b.template end
		return a.text < b.text
	end)
	local mods = array({})
	for _, mod in ipairs(supportedList) do
		local sources = array({})
		for source in pairs(mod.sources) do sources[#sources + 1] = source end
		table.sort(sources)
		mods[#mods + 1] = { text = mod.text, sources = sources }
	end
	local result = { mods = mods }
	modBrowserCache = { version = treeVersion, result = result }
	return result
end

-- ---------------------------------------------------------------------------
-- Notes
-- ---------------------------------------------------------------------------

M.get_notes = function()
	ensureBuild()
	local ctl = build.notesTab and build.notesTab.controls and build.notesTab.controls.edit
	return { text = ctl and ctl.buf or "" }
end

M.set_notes = function(p)
	ensureBuild()
	local ctl = build.notesTab and build.notesTab.controls and build.notesTab.controls.edit
	if not ctl then error("notes tab unavailable", 0) end
	ctl:SetText(p and p.text or "")
	build.notesTab.modFlag = true
	build.modFlag = true
	return { ok = true }
end

-- ---------------------------------------------------------------------------
-- Checks
-- ---------------------------------------------------------------------------

-- Exposed for `pobctl eval` scripting: __bridge.tree_click({ id = 123 })
_G.__bridge = M

M.sanity_check = function()
	ensureBuild()
	local output = build.calcsTab.mainOutput
	local warnings = array({})
	local function warn(fmt, ...) warnings[#warnings + 1] = string.format(fmt, ...) end
	for _, res in ipairs({ "FireResist", "ColdResist", "LightningResist" }) do
		if output[res] and output[res] < 75 then
			warn("%s is %.0f%%, below the 75%% cap", res, output[res])
		end
	end
	if output.ChaosResist and output.ChaosResist < 0 then
		warn("ChaosResist is %.0f%%, negative", output.ChaosResist)
	end
	if output.Life and (build.characterLevel or 1) >= 30 and output.Life < 500 then
		warn("Life is %.0f, which looks very low for character level %d", output.Life, build.characterLevel or 0)
	end
	return { warnings = warnings }
end

return M
