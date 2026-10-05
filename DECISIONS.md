Prioritization: 
- scaffold first, then start implementing
- core requirements come before config features - start with proxying before defining individual route matching behaviors so we can define error behaviors (disconnect, 502, 504) before anyting depends on it
- build a request pipeline, modeled on nginx's phases and modules, for extensibility, code clarity / cleanliness (see 'pipeline' section beow)
- once basic gateway functionality is implemented, this is the order I built features in:
    - Auth - start with Auth as the most important feature - making sure unauthorized users can't access or change data is the most important security role of an API gateway
    - rate limiting: Next up are matters concerning production reliability - based on predicted traffic, we should be able to ramp up availability in a controlled fashion rather than having to handle unexpected spikes reactively, and also protect against DDOS
    - Load balancing: crucial in high-traffic production environments

Proxy:
- stream request bodies instead of holding in memory to control memory use
- global timeout was chosen to be the time until the upstream *starts* responding. If it hasn't started in time we return 504, but once it starts the body can take as long as it needs

Pipeline:
- makes extensibility very clear-cut
- makes ordering of gateway features explicit and easy to read
- cleans up the gateway.js file so it doesn't grow forever

Rate limiting:
- I chose to implement the sliding_window rate limiting using the two window approach - instead of storing timestamps. This allows us to use constant memory (instead of having to store increasing large arrays of timestamps for each client and for each route), and also fixes a boundary issue

Load balancing:
- use same algorithm as nginx for weighted round robin (smooth weighted round robin)
- round robin ignores weights and is the default if balance is not specified


What I'd implement next with more time:
- Redis (or similar cacheing) to store counters for timeout (they live in memory, one gateway process at a time). Running several instances of our gateway would 
- Have load balancers check health of targets as part of their balancing algorithm