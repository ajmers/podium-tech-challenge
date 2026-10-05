Prioritization: 
- scaffold first, then start implementing
- core requirements come before config features - start with proxying before defining individual route matching behaviors so we can define error behaviors (disconnect, 502, 504) before anyting depends on it
- build a request pipeline, modeled on nginx's phases and modules, for extensibility, code clarity / cleanliness (see 'pipeline' section beow)
- once basic gateway functionality is implemented, start with Auth as the most important feature (prioritized over rate limiting)

Proxy:
- stream request bodies instead of holding in memory to control memory use
- global timeout was chosen to be the time until the upstream *starts* responding. If it hasn't started in time we return 504, but once it starts the body can take as long as it needs

Pipeline:
- makes extensibility very clear-cut
- makes ordering of gateway features explicit and easy to read
- cleans up the gateway.js file so it doesn't grow forever