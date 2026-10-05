Prioritization: 
- scaffold first, then start implementing
- core requirements come before config features - start with proxying before defining individual route matching behaviors so we can define error behaviors (disconnect, 502, 504) before anyting depends on it

Proxy:
- stream request bodies instead of holding in memory to control memory use


