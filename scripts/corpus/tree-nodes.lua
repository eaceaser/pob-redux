-- pobctl eval "OUT=[[tree-nodes.json]] return dofile([[tree-nodes.lua]])"
local B = __bridge
local dkjson = require("dkjson")
B.new_build({ name = "tree nodes" })
local spec = main.modes["BUILD"].spec
local nodes = {}
local count = 0
for id, node in pairs(spec.nodes) do
	nodes[tostring(id)] = { name = node.dn or node.name, type = node.type, ascendancy = node.ascendancyName }
	count = count + 1
end
local f = assert(io.open(OUT, "wb"))
f:write(dkjson.encode({ treeVersion = spec.treeVersion, nodes = nodes }))
f:close()
return { nodes = count, treeVersion = spec.treeVersion }
