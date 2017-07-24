#!/usr/bin/env node
// Author - Dan Wolanski
// This is a sample, showing how to use the request module to create a 
// Http 'long polling' connection for use with the XMS REST API
// then will peform a simple call flow of "play followed by record"
//
// This script is dependant on the following npm packages
//			request - Simplified HTTP request client.
//			xml2js - Simple XML to JavaScript object converter.
//			yargs - Light-weight option parsing with an argv hash. No optstrings attached.
//			events - Used to signal async operations such as events or function completion
//			keypress - Make process.stdin begin to emitt keypress events
//			winston - A multi-transport async logging library for node.js


var argv = require('yargs')
	.usage('Usage: $0 -h [hostename] -p [port] -a [appid] -l [loglevel]')
	.default('h','127.0.0.1')
	.alias('h','hostname')
	.default('p','81')
	.alias('p','port')
	.default('a','app')
	.alias('a','appid')
	.default('l','info')
	.alias('l','loglevel')
	.default('c','warn')
	.alias('c','consoleloglevel')
	.default('f','node-xms.txt')
	.alias('f','logfile')
	.argv;

var logger = require('winston');
logger.level = argv.loglevel;
logger.remove(logger.transports.Console);
logger.add(logger.transports.Console, {'timestamp':true , 'colorize':true , 'level':argv.consoleloglevel});
logger.add(logger.transports.File, { 'filename': argv.logfile , 'timestamp':true , 'json':false});
logger.info('Setting logfile level to '+argv.loglevel+' and console log level to '+argv.consoleloglevel);

//using this header for all requests
var headers = {"Content-Type":"application/xml" };

var request = require('request'),
 parseString = require('xml2js').parseString,
 events = require('events'),
 keypress = require('keypress');

//class MyEmitter extends EventEmitter {}
var myEmitter = new events.EventEmitter(); 

var confurl="";
var confid="";
var callers = [];

// This will capture the Ctrl-C
process.on('SIGINT', () => {
	setTimeout(function(){ process.exit() }, 5000);		
   logger.log('warn','Quiting  - Cleaning up');
	callers.forEach(function(href){
		DropCall(href);
	});
});
//Setup the keypress to produce events, this lets you issue q to cleanup
keypress(process.stdin);
process.stdin.on('keypress', function (ch, key) {
	if(key && key.name == 'q'){
	setTimeout(function(){ process.exit() }, 5000);		
	   logger.log('warn','Quiting due to q keypress - Cleaning up');
		callers.forEach(function(href){
			DropCall(href);
		});
		//Wait for 5 seconds for everything to cleanup and then force exit
}
});
 
//Start by creating the event monitor
logger.log('info','******************************');
logger.log('info','* STARTING XMS Event Monitor *');
logger.log('info','******************************');
var data="<web_service version=\"1.0\"> <eventhandler><eventsubscribe action=\"add\" type=\"any\" resource_id=\"any\" resource_type=\"any\"/> </eventhandler></web_service>";

//TODO- Should likely also include a flag for https vs http
var url='http://'+argv.hostname+':'+argv.port+'/default/eventhandlers?appid='+argv.appid;
var options={
	method: 'POST',
	url: url,
	headers:headers,
	body: data
};

logger.log('verbose','C->S: POST to '+url+':\n');
request(options, function (error,response,body){ 
	logger.log('verbose',"S->C: RESPONSE: %j",response);
	if(!error && response.statusCode == 201){
		logger.log('debug',body);
		parseString(body,function(err,result){
			if(err){
				logger.error(err);
			}
			logger.log('debug',"%j",result);
			//Here we need to parse the response for the href that will be used to start the long poll
			var href=result.web_service.eventhandler_response[0].$.href;
			logger.log('debug',"href="+href)  ;
			url='http://'+argv.hostname+':'+argv.port+href+'?appid='+argv.appid;
			logger.log('info',"New url for eventhandler="+url);
			});
		logger.log('verbose','C->S: Starting event monitor via GET to '+url);
		//Starting the long poll, this will keep the http GET active and deliver each event as a chunked response
		// The callback for 'data' is used to process each event.
		request
			.get(url)
			.on('response',function(res){				
				res.on('data',eventcallback);
				res.on('end',eventendcallback);
			});
			
			myEmitter.emit('EventhandlerStarted');
	} else {
		logger.error("ERROR connecting to XMS!!");
		process.exit();
	}
	});

// Here is the folow for the application
myEmitter.on('Event',processEvent);


///////////////////////////////////////////////////////////////////////////////
//FUNCTIONS
////////////////////////////////////////////////////////////////////////////////


//This function will be used as the callback for each event in the long poll
//The format of the event in is first the size followed by the XML event
var tmpbuffer=""; 
//Note this tmpbuffer will be used to save partial events that may be received
function eventcallback(eventbuffer){

	//First check to make sure there is actual data inside the current buffer
	if(eventbuffer.length > 0){
		
		logger.log('silly',"Eventcallback, eventbuffer=["+eventbuffer+"]");
		var eventdata=eventbuffer.toString('ascii' );
		
		//Check to see if there is any data left over from previous processing, 
		// if so prepend it to current event buffer before processing and clear the pending buffer
		if(tmpbuffer.length > 0){
			logger.log('debug',"Appending fragment to start of buffer");
			eventdata=tmpbuffer+eventbuffer.toString('ascii' );
			tmpbuffer="";
		}
		logger.log('verbose','S->C: Event [size=0x'+eventdata+']');
		
		//Checking to see if there are multiple events contained in the data buffer.  Format of the stream will be
		// length of event followed by <web_service> event.  
		// This logic will simple split up the buffer into multiple events by looking for the end tag of the webservice
		// and splitting on it.  The replace is added because the node lookahead/behind doesn't work in all cases
		// and the delimiter is needed to deserialize so the replace is done to insert a delimiter to split on and still
		// have the full xml
		//TODO - Improve logic here used to split events.
		var data=eventdata.replace("</web_service>\n","</web_service>CLIPEVENTHERE");
		var events=data.split(/CLIPEVENTHERE/);
		if(events.length > 1){
			logger.log('debug','Multiple Events found inside the eventdata, eventcount='+events.length);
		}
		// Once split, then process each event
		events.forEach(function(event){
			logger.log('debug','{{ '+event+' }}');
			//Check to make sure the event has both the opening and closing tags, if not, it may be a partal
			//  buffer.  
			if( event.includes('<web_service') && event.includes('</web_service>') ){
				// Pull the byte count from the first line of the message
				var bytecount=parseInt(event.substr(0,event.indexOf('<web_service')),16);
				// Next pull out the xml partion of the event.
				var xml=event.substring(event.indexOf('<web_service'),event.indexOf('</web_service>')+14);
				// TODO- Should put a check in there to see if the bytecount provided matches actual bytecount of xml
				logger.log('debug','------------------------------------------------------------');	
				logger.log('debug',"bytecount="+bytecount+",xml length="+xml.toString('ascii' ).length);
				logger.log('debug',xml);
				//Using the xml2js to convert the xml to json for easy parsing
				parseString(xml,function(err,evt){
					if(err){
						//TODO- Include some more robust error processing/logging
						logger.error(err);
					} else{
						//logger.log(xml);
						//Fire off the xml data to the processor for further processing
						myEmitter.emit('Event',xml);
					}
				}); //TODO we should check that the parseString was succesfful
			}
			else{
				// If the event doesn't have an opening and closing tag, it is likely a partial buffer, saving
				// contents for the next buffer to process
				logger.log('debug',"Not a fully formed message,saving fragment for next buffer");
				logger.log('verbose',"Saving partial buffer ["+event+"]");
				tmpbuffer=event;
			}
			
		});
	}
}

//This is the notification that the EVENT monitor was terminated,
function eventendcallback(){
	logger.log('warn',"S->C: EVENT Monitor Terminated by server");
	//TODO ReEstablish the connection or cleanup connections and exit
}

//This is the function that will be triggered on the 'Event' firing
function processEvent(evtxml){
	parseString(evtxml, function (err,evt){
		// Note $ is used in the package for the attributs
		// Incoming call event
		if(evt && evt.web_service){
			var href=evt.web_service.event[0].$.resource_id;
			if(href){
				logger.log('info',href +" - "+evt.web_service.event[0].$.type+" event received");
			}
			//Checking to see if there is a hangup, this is put int to prevent 404 messages sent
			// because of state machine progressing on terminated calls.
			//TODO - Put in better use of the json/XML parsing rather then string searching the message
			if(evtxml.match(/<event_data name="reason" value="hangup"/)){
				logger.log('info',href+" - Hangup found in the event reason, waiting for hangup message");
				// Just returning the hangup message should be soon.
				return;

			}
			
			if(evt.web_service.event[0].$.type == 'incoming'){
				//guid is the tag that is used to find the call in logs and traces, printing out here 
				// to allow for matching between href and guid
				var guid="";
				logger.log('info',href+" - New Incoming Call detected");
				logger.log('verbose',href+" - Incoming Event["+evtxml+"]");
				//First add the call to the caller list 
				callers.push(href);
				//Then answer the call
				AnswerCall(href);
 
			// Call was hungup, not that XMS will delete the resources and automaticly remove the caller from the conf 
			//  so really all there is to do is update the local side
			}else if(evt.web_service.event[0].$.type == 'hangup'){
				
				//Find the call and remove it from the callers list
				var index=callers.indexOf(href);
				if (index > -1) {
					callers.splice(index,1);
				}
			//This is generated when the answer has completed when async_completion is enabled
			}else if(evt.web_service.event[0].$.type == 'accepted'){
			}
			//Indicates that the call messaging has completed and call is "answered"
			else if(evt.web_service.event[0].$.type == 'answered'){
				//Media can be started here, or could be done after streaming event is delivered depending if you wish to
				//  ensure RTP establishment or not.
				Play(href, "file://verification/video_clip_newscast");
			}
			//This event is when the ICE has completed and the stream has started.  If using media operations is usually best to trigger off this event rather then the answered to ensure the media path is there
			else if(evt.web_service.event[0].$.type == 'stream'){
				
			}
			else if(evt.web_service.event[0].$.type == 'streaming'){
				
			}
			//This event indicates that your media operation has started on the channel
			else if(evt.web_service.event[0].$.type == 'media_started'){
				
			}
			//Indication that the play has completed
			else if(evt.web_service.event[0].$.type == 'end_play'){
				//Our state machine indicates that record should be done at this point
				Record(href,"recorded/recfile_"+href+".wav");
			}
			else if(evt.web_service.event[0].$.type == 'end_record'){
				//In this test case, we will keep call connected forever, but if you wish the XMS to terminate the call instead
				// the following can be uncommented
				//DropCall(href);
			}
			//This event is sent periodicly to let app know that the server and call are still alive
			else if(evt.web_service.event[0].$.type == 'keepalive'){
				
			}
			//Generated when the RTP stream is no longer being detected by the XMS
			else if(evt.web_service.event[0].$.type == 'alarm'){
			}
			//All other events are just logged and ignored
			else {
				logger.log('warn',"Unknown event detected:\n"+evt.web_service.event[0].$.type);
			}
		} else {
			//Really shouldn't ever be able to get here as there is a check in event receiver.
			logger.log('warn',"Event did not contain a web_service");
		}
	});	
}

// Functions used to send REST messages for different operations (Answer,Play,Record,Dropcall)
function AnswerCall(href){
  var url='http://'+argv.hostname+':'+argv.port+'/default/calls/'+href+'?appid='+argv.appid;
   var data="<?xml version=\"1.0\" encoding=\"UTF-8\"?><web_service version=\"1.0\"><call answer=\"yes\" async_completion=\"yes\" media=\"audiovideo\"/></web_service>";
  
  var options={
	method: 'PUT',
	url: url,
	headers:headers,
	body: data
	};
   logger.log('verbose','C->S: PUT to '+url+':\n');
   request(options, function(error,response,body){
	logger.log('verbose',"S->C: RESPONSE: %j body",response);
	if(!error && response.statusCode == 200){
		logger.log('info',href+' - Answer Initiated, waiting on answered event');
	} else {
		logger.error(href+' - Error answering Call('+href+') statusCode='+response.statusCode);
	}
   });

}
function Play(href, playfile){
  var url='http://'+argv.hostname+':'+argv.port+'/default/calls/'+href+'?appid='+argv.appid;
  
   var data="<?xml version=\"1.0\" encoding=\"UTF-8\"?><web_service version=\"1.0\"><call><call_action><play offset=\"0s\" delay=\"0s\" repeat=\"0\" terminate_digits=\"#\"><play_source location=\"file://verification/video_clip_newscast\"/></play></call_action></call></web_service>";
  var options={
	method: 'PUT',
	url: url,
	headers:headers,
	body: data
	};
   logger.log('verbose','C->S: PUT to '+url+':\n');
   request(options, function(error,response,body){
	logger.log('verbose',"S->C: RESPONSE: %j body",response);
	if(!error && response.statusCode == 200){
		logger.log('info',href+' - Play of '+playfile+' Initiated, waiting on play_end event');
	} else {
		logger.error(href+' - Error Playing file('+href+') statusCode='+response.statusCode);
	}
   });

}
function Record(href, recfile){
  var url='http://'+argv.hostname+':'+argv.port+'/default/calls/'+href+'?appid='+argv.appid;
  
   var data="<?xml version=\"1.0\" encoding=\"UTF-8\"?><web_service version=\"1.0\"><call><call_action><record terminate_digits=\"#\" max_time=\"30s\" recording_audio_type=\"audio/x-wav\" recording_audio_uri=\"file://"+recfile+"\"><recording_audio_mime_params codec=\"L16\" rate=\"16000\"/></record></call_action></call></web_service>";
  var options={
	method: 'PUT',
	url: url,
	headers:headers,
	body: data
	};
   logger.log('verbose','C->S: PUT to '+url+':\n');
   logger.log('info',href+' - Sending Record ');
   request(options, function(error,response,body){
	logger.log('verbose',"S->C: RESPONSE: %j body",response);
	if(!error && response.statusCode == 200){
		logger.log('info',href+' - Record of '+recfile+' Initiated, waiting on record_end event');
	} else {
		logger.error(href+' - Error Recording file('+href+') statusCode='+response.statusCode);
	}
   });

}

function DropCall(href){
  var url='http://'+argv.hostname+':'+argv.port+'/default/calls/'+href+'?appid='+argv.appid;
  var options={
	method: 'DELETE',
	url: url,
	headers:headers,
	};
   logger.log('verbose','C->S: DELETE to '+url+':\n');
   
   request(options, function(error,response){
	logger.log('verbose',"S->C: RESPONSE: %j",+response);
	if(error){
		logger.error(href+' - Error DELETEing Call('+href+') statusCode='+response.statusCode);
	} else {
		logger.log('info',href+' - Call has been DELETED');
		//Find the call and remove it from the callers list
		var index=callers.indexOf(href);
		if (index > -1) {
			callers.splice(index,1);
		}
	}
   });

}
