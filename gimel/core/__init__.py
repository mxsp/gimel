"""Gimel core — planning functions: no database, no I/O, no wall clock.

Two exceptions, see CLAUDE.md: ``nesting`` times its candidates for the ``max_ms``
budget, ``nesting_gre`` imports the plugin seam. This is the one copy of the
planning code. Alef imports it from here.

  layout    floor geometry, aisle network, shortest walking routes
  robot     pose on a route (loop / ping-pong), pure geometry
  robot_way robot routes as polyline, checked against outline and obstacles
  robot_dispatch which robot takes a transport, with hard limits and a reason
  robot_state which transport state change is allowed, with a reason
  routing   which station takes a job, with named, weighted factors
  worklist  what is next at a station (pick / cut / pack / process)
  batch     combine waiting positions by material + thickness, release policy
  nesting   sheet nesting (skyline + hole filling, 90° rotation, mirroring)
  cutting   cut order per machine kind
  pricing   the plain price formula used when no application brings its own
  geometry  part contours: perimeter, area, holes
  types     value types shared by the above
"""
