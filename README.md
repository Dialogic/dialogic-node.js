# dialogic-node.js
Repository for sample node.js scripts and libraries for use with XMS


node-xmseventmon.js - 
This is a sample, showing how to use the request module to create a 
Http 'long polling' connection for use with the XMS REST API

 This script is dependant on the following npm packages
			request - Simplified HTTP request client.
			xml2js - Simple XML to JavaScript object converter.
			yargs - Light-weight option parsing with an argv hash. No optstrings attached.
            
Script takes the following optional paramiters
    --hostname/-h    Hostname/IP of the XMS server [default: 127.0.0.1]
    --port / -p      Port for REST interface  [default: 81]
    --appid / -a     Appid to register with   [default: app]