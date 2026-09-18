-- pobctl eval "JOB=[[job.json]] OUT=[[stages.jsonl]] XMLDIR=[[dir]] return dofile([[ingest.lua]])"

local B = __bridge
local dkjson = require("dkjson")

local function readAll(path)
	local f = assert(io.open(path, "rb"))
	local text = f:read("*a")
	f:close()
	return text
end

local function writeAll(path, text)
	local f = assert(io.open(path, "wb"))
	f:write(text)
	f:close()
end

local function keysSorted(t)
	local out = {}
	for k in pairs(t) do out[#out + 1] = k end
	table.sort(out)
	return out
end

-- The bridge marks JSON null with a userdata that dkjson cannot encode.
local function sanitize(v)
	if type(v) == "userdata" then return dkjson.null end
	if type(v) ~= "table" then return v end
	local out = {}
	for k, x in pairs(v) do out[k] = sanitize(x) end
	return setmetatable(out, getmetatable(v))
end

local function effectiveDps(out)
	local own = out.CombinedDPS or 0
	local minion = out.Minion and (out.Minion.CombinedDPS or out.Minion.TotalDPS) or 0
	return math.max(own, minion)
end

-- Ladder exports often keep an aura or companion as the main skill, which shows 0 DPS.
local function fixMainSkill(bd)
	local out = bd.calcsTab.mainOutput or {}
	if effectiveDps(out) > 0 then return nil end
	local original = bd.mainSocketGroup
	local best, bestDps = nil, 0
	for gi, group in ipairs(bd.skillsTab.socketGroupList) do
		local active = false
		for _, gem in ipairs(group.gemList) do
			local ge = gem.gemData and gem.gemData.grantedEffect
			if gem.enabled ~= false and ge and not ge.support then active = true end
		end
		if group.enabled ~= false and active and gi ~= original then
			local ok = pcall(B.set_main_skill, { index = gi })
			local dps = ok and effectiveDps(bd.calcsTab.mainOutput) or 0
			if dps > bestDps then best, bestDps = gi, dps end
		end
	end
	pcall(B.set_main_skill, { index = best or original })
	return best and { from = original, to = best } or nil
end

local STAT_KEYS = {
	"Life", "EnergyShield", "Mana", "TotalEHP", "CombinedDPS", "FullDPS", "TotalDPS", "Armour", "Evasion",
	"FireResist", "ColdResist", "LightningResist", "ChaosResist", "BlockChance", "SpellBlockChance",
	"MovementSpeedMod", "Spirit", "SpiritUnreserved", "Str", "Dex", "Int", "PhysicalMaximumHitTaken",
}

local function stageRecord(src, loadoutName)
	local bd = main.modes["BUILD"]
	local spec = bd.spec
	local fixed = fixMainSkill(bd)
	local out = bd.calcsTab.mainOutput or {}
	local summary = B.build_summary()

	local nodes, ascNodes = {}, {}
	for id, node in pairs(spec.allocNodes) do
		local start = node.type == "ClassStart" or node.type == "AscendClassStart"
		if not start and node.ascendancyName then
			ascNodes[#ascNodes + 1] = id
		elseif not start then
			nodes[#nodes + 1] = id
		end
	end
	table.sort(nodes)
	table.sort(ascNodes)

	local items = {}
	for _, slotName in ipairs(keysSorted(bd.itemsTab.slots)) do
		local slot = bd.itemsTab.slots[slotName]
		local item = slot.selItemId and slot.selItemId ~= 0 and bd.itemsTab.items[slot.selItemId]
		if item and not slot.nodeId then
			local explicit = #(item.explicitModLines or {})
			local mods = explicit + #(item.implicitModLines or {}) + #(item.runeModLines or {})
			items[#items + 1] = { slot = slotName, rarity = item.rarity, name = item.title or item.name, base = item.baseName, mods = mods, explicit = explicit }
		end
	end

	local skills = {}
	for _, group in ipairs(bd.skillsTab.socketGroupList) do
		if group.enabled ~= false and not group.source then
			local gems = {}
			for _, gem in ipairs(group.gemList) do
				if gem.enabled ~= false then
					gems[#gems + 1] = gem.gemData and gem.gemData.name or gem.nameSpec
				end
			end
			if #gems > 0 then skills[#skills + 1] = gems end
		end
	end

	local stats = {}
	for _, key in ipairs(STAT_KEYS) do
		local v = out[key]
		if type(v) == "number" and v == v and v ~= math.huge and v ~= -math.huge then stats[key] = v end
	end
	if out.Minion then
		local m = out.Minion.CombinedDPS or out.Minion.TotalDPS
		if type(m) == "number" and m == m and m ~= math.huge then stats.MinionDPS = m end
	end
	stats.EffectiveDPS = effectiveDps(out)

	local findings = {}
	local okSanity, sanity = pcall(B.sanity_check)
	if okSanity and sanity and sanity.findings then
		for _, f in ipairs(sanity.findings) do
			findings[#findings + 1] = { severity = f.severity, area = f.area, message = f.message }
		end
	end

	return {
		source = src.id,
		loadout = loadoutName or dkjson.null,
		buildName = bd.buildName,
		className = spec.curClassName,
		ascendancy = spec.curAscendClassName or dkjson.null,
		level = bd.characterLevel,
		mainSkill = summary.mainSkill ~= nil and summary.mainSkill or dkjson.null,
		mainSocketGroup = bd.mainSocketGroup,
		mainSkillFixed = fixed ~= nil,
		pointsSpent = summary.passivePointsSpent,
		pointsAvailableMax = summary.pointsAvailableMax,
		ascendancyPoints = summary.ascendancyPointsUsed,
		activeSkills = summary.activeSkills,
		nodes = nodes,
		ascendancyNodes = ascNodes,
		items = items,
		skills = skills,
		stats = stats,
		findings = findings,
	}
end

local job = dkjson.decode(readAll(JOB))
local outFile = assert(io.open(OUT, "ab"))
local done, failed, stages = 0, 0, 0

for _, src in ipairs(job) do
	local ok, err = pcall(function()
		local text = readAll(src.path)
		if src.format == "build" then
			B.import_game_build({ json = text, name = src.name })
		else
			local code = text
			if src.format == "ninja" then code = dkjson.decode(text).pob end
			B.load_build_code({ code = (code:gsub("%s+", "")), name = src.name })
		end
		writeAll(XMLDIR .. "/" .. src.id .. ".xml", B.save_build_xml().xml)
		local lo = B.get_loadouts()
		local names = {}
		for _, n in ipairs(lo.loadouts or {}) do names[#names + 1] = n end
		if #names == 0 then
			outFile:write(dkjson.encode(sanitize(stageRecord(src, nil))), "\n")
			stages = stages + 1
		else
			for _, name in ipairs(names) do
				local okSel, selErr = pcall(B.select_loadout, { name = name })
				if okSel then
					outFile:write(dkjson.encode(sanitize(stageRecord(src, name))), "\n")
				else
					outFile:write(dkjson.encode({ source = src.id, loadout = name, error = tostring(selErr) }), "\n")
				end
				stages = stages + 1
			end
		end
	end)
	if ok then
		done = done + 1
	else
		failed = failed + 1
		outFile:write(dkjson.encode({ source = src.id, error = tostring(err) }), "\n")
	end
	outFile:flush()
end
outFile:close()
return { sources = #job, loaded = done, failed = failed, stages = stages }
