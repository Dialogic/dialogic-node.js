#!/usr/bin/env node
// Author - Dan Wolanski
// This is a sample, showing how to use the request module to create a 
// Http 'long polling' connection for use with the XMS REST API
//
// This script is dependant on the following npm packages
//			request - Simplified HTTP request client.
//			xml2js - Simple XML to JavaScript object converter.
//			yargs - Light-weight option parsing with an argv hash. No optstrings attached.

var argv = require('yargs')
	.usage('Usage: $0 -h [hostename] -p [port] -a [appid]')
	.default('h','127.0.0.1')
	.alias('h','hostname')
	.default('p','81')
	.alias('p','port')
	.default('a','app')
	.alias('a','appid')
	.argv;
console.log('Script Arguments are:  ');
console.log(argv);


var request = require('request'),
 parseString = require('xml2js').parseString;


console.log('******************************');
console.log('* STARTING XMS Event Monitor *');
console.log('******************************');
var data="<web_service version=\"1.0\"> <eventhandler><eventsubscribe action=\"add\" type=\"any\" resource_id=\"any\" resource_type=\"any\"/> </eventhandler></web_service>";

var headers = {"Content-Type":"application/xml" };
//TODO- Should likely also include a flag for https vs http
var url='http://'+argv.hostname+':'+argv.port+'/default/eventhandlers?appid='+argv.appid;
var options={
	method: 'POST',
	url: url,
	headers:headers,
	body: data
};

console.log('C->S: POST to '+url+' OPTIONS:');
console.log(options);
request(options, function (error,response,body){
	console.log('S->C: RESPONSE:'+response.toString('ascii'));
	if(!error && response.statusCode == 201){
//		console.log(body);
		parseString(body,function(err,result){
			console.log(result);
			//Here we need to parse the response for the href that will be used to start the long poll
			var href=result.web_service.eventhandler_response[0].$.href;
			console.log("href="+href)  ;
			url='http://'+argv.hostname+':'+argv.port+href+'?appid='+argv.appid;
			console.log("New url="+url);
	  });
		console.log('C->S: Starting event monitor via GET to '+url);
		//Starting the long poll, this will keep the http GET active and deliver each event as a chunked response
		// The callback for 'data' is used to process each event.
		request
			.get(url)
			.on('response',function(res){				
				res.on('data',eventcallback);
				res.on('end',eventendcallback);
			});
		
	} else {
		console.log("ERROR connecting to XMS!!");
	}
});


function eventcallback(eventbuffer){
	
	if(eventbuffer.length > 0){
		//console.log(eventbuffer);
		var event=eventbuffer.toString('ascii' );
		console.log('S->C: Event [size='+event+']');
		//The first value in the buffer will be the size right before the <web_service XML starts in hex
		var bytecount=event.substr(0,event.indexOf('<web_service'));
		//TODO- need to check max size and XML Boundries in case of EVENTS spanning packets
		var xml=event.substr(event.indexOf('<web_service'));
		
		parseString(xml,function(err,evt){
			//console.log(evt);
			//Callback or processing of events would go here
		});
	
	}
}

function eventendcallback(){
	console.log("S->C: EVENT Monitor Terminated by server");
}

